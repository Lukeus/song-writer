import { AgentPanel } from "./AgentPanel";
import type { Utility } from "../types";

export const aiAgentUtility: Utility = {
  id: "ai-agent",
  title: "AI Agent",
  render: (ctx) => <AgentPanel {...ctx} />,
};
