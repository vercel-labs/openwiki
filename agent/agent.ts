import { defineAgent } from "eve";
import { getOpenWikiAgentModel } from "./lib/model-config.js";

export default defineAgent({
  model: getOpenWikiAgentModel(),
});
