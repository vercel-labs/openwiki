import { defineAgent } from "eve";
import { getOpenWikiIndexModel } from "../../lib/model-config.js";

export default defineAgent({
  description: "Draft all OpenWiki pages from an accepted outline, repository summary, and relevant source snippets.",
  model: getOpenWikiIndexModel(),
});
