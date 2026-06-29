import { defineAgent } from "eve";
import { getOpenWikiIndexModel } from "../../lib/model-config.js";

export default defineAgent({
  description:
    "Create a multi-page, source-grounded OpenWiki outline from repository metadata, file inventory, and selected snippets.",
  model: getOpenWikiIndexModel(),
});
