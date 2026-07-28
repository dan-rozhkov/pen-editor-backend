import { loadConfig } from "../config.js";
import { generateImage } from "../services/imageGen.js";
import { runAsScript } from "./cli.js";

// CLI entrypoint for `npm run showcase:image -- "a prompt" "another prompt"`.
//
// It is the same `generateImage` the browser reaches through
// /api/generate-image and the autonomous runner calls directly — exposed as a
// command so a hand-authored showcase run (see ingestRun.ts) can get real
// generated imagery without a server or a browser tab. Prints one
// `url<TAB>prompt` line per image so the output can be pasted straight into
// the screens' HTML.
//
// Sequential on purpose: each call is a model request with a 90s deadline, and
// the point here is a legible log, not throughput.
async function main(): Promise<void> {
  const prompts = process.argv.slice(2).filter((a) => !a.startsWith("--"));

  if (prompts.length === 0) {
    console.error('[image] usage: npm run showcase:image -- "describe the frame" [...]');
    process.exit(1);
  }

  const config = loadConfig();
  let failed = 0;

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    try {
      const { url } = await generateImage(config, prompt);
      console.log(`${url}\t${prompt}`);
    } catch (err) {
      failed += 1;
      console.error(`[image] ${i + 1}/${prompts.length} failed: ${(err as Error).message}`);
    }
  }

  if (failed > 0) process.exitCode = 1;
}

runAsScript(import.meta.url, "image", main);
