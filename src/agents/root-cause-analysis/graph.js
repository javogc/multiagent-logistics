import { StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import { createBedrockClient } from "../../integrations/bedrock/chat.js";
import { StateAnnotation } from "./state.js";
import { getTools } from "./tools.js";

// Get available tools
const tools = getTools();

/**
 * Create a tool node for handling tool calls
 */
const toolNode = new ToolNode(tools);

/**
 * Define the function that calls the model
 */
export async function callModel(state, config) {
  const model = createBedrockClient();
  const bindedModel = model.bindTools(tools);

  // Create a prompt template for logistics analysis
  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      `You are a logistics root cause analysis expert. 
      You receive delayed shipment details and analyze the root cause using available data.
      
      Your process:
      1. Analyze the shipment delay details
      2. Retrieve carrier history to identify patterns
      3. Generate a comprehensive incident report with actionable recommendations
      
      Be concise and data-driven in your analysis.`,
    ],
    new MessagesPlaceholder("messages"),
  ]);

  // Format the prompt with the current state
  const formattedPrompt = await prompt.formatMessages({
    messages: state.messages,
  });

  try {
    const result = await bindedModel.invoke(formattedPrompt);
    return { messages: [result] };
  } catch (error) {
    console.error("Error calling model:", error);
    return {
      messages: [
        {
          role: "ai",
          content: "Error analyzing shipment. Please try again.",
        },
      ],
    };
  }
}

/**
 * Determine the next step in the graph
 */
export function shouldContinue(state) {
  const messages = state.messages;
  const lastMessage = messages[messages.length - 1];

  // If the last message has tool calls, route to tools node
  if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
    return "tools";
  }

  // Otherwise, end the graph
  return "__end__";
}

export function createAgentGraph(client, dbName) {
  const builder = new StateGraph(StateAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", toolNode)
    .addEdge("__start__", "agent")
    .addConditionalEdges("agent", shouldContinue)
    .addEdge("tools", "agent");

  let checkpointer = null;
  if (client && dbName) {
    checkpointer = new MongoDBSaver({ client, dbName });
  }

  const graph = builder.compile({ checkpointer });
  graph.name = "Root Cause Analysis Agent";

  return graph;
}