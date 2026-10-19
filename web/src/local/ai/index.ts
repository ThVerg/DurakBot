// Public entry point of the in-browser bots (consumed by the local session).
export { availableAgents, getAgent, preloadAI, HeuristicAgent, RandomAgent, SolverAgent } from "./registry";
export type { Agent, AgentOptions } from "./types";
export { ChampionAgent, CHAMPION_DEFAULTS } from "./champion";
export { LEVELS, LevelAgent } from "./levels";
export { applicable as solverApplicable, loadSolver } from "./solver";
export { loadModel } from "./model";
export { configureAI, aiConfig } from "./runtime";
