// Attaching a file to a chat so the model can read it.
//   tsx examples/05-file-upload.ts [path/to/file.pdf]   (or: pnpm example:file)
//
// With no argument it attaches a small in-memory Markdown document, so the
// example runs with zero setup. Pass a path to attach a real file (PDF, PNG,
// CSV, …) — it's read lazily via `openAsBlob`, never fully buffered.
import { openAsBlob } from "node:fs";
import { basename, extname } from "node:path";
import { CoderAgent, type FileContent } from "../src/index.js";
import { heading, loadEnv } from "./_shared.js";

// Extension → chat-attachment media type (the server allowlist is narrow).
const MEDIA_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
};

const { baseUrl, token, organizationId, model } = await loadEnv();

// Resolve what to attach: a real file if a path was given, else an in-memory doc.
const path = process.argv[2];
let content: FileContent;
let mediaType: string;
let name: string;
if (path) {
  content = await openAsBlob(path); // lazy Blob — not read fully into memory
  mediaType = MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  name = basename(path);
} else {
  content = new TextEncoder().encode(
    "# Q3 Report\n\n- Revenue up 18% QoQ\n- Churn down to 2.1%\n- Hiring freeze lifted\n",
  );
  mediaType = "text/markdown";
  name = "q3-report.md";
}

const agent = new CoderAgent({
  baseUrl,
  token,
  organizationId,
  model,
  instructions: "You are a concise analyst. Answer in two or three sentences.",
});

try {
  heading("attach a file, then ask about it");

  // `attach()` uploads once and returns a handle. Its `toFilePart()` references
  // the file by id, so it can be reused across turns without re-uploading.
  const file = await agent.attach({ content, mediaType, name });
  console.log("Uploaded     :", name, `(${file.mediaType}) → ${file.id}`);

  const result = await agent.generate({
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: `Summarize ${name}.` }, file.toFilePart()],
      },
    ],
  });
  console.log("Answer       :", result.text);
  console.log("Chat id      :", agent.chatId);

  // Alternatively, for bytes you already hold, skip attach() and inline the
  // file — it's uploaded for you transparently:
  //
  //   await agent.generate({ messages: [{ role: "user", content: [
  //     { type: "text", text: "Summarize this." },
  //     { type: "file", data: bytes, mediaType: "application/pdf", filename: "r.pdf" },
  //   ]}]});
  //
  // For large or non-allowlisted files (a 20 MiB zip of assets, a dataset, a
  // binary) — material for the agent to *operate on* rather than read — write it
  // to the workspace instead. Bind the chat to a workspace and supply a
  // `workspaceFiles` adapter (e.g. over a @coder/ai-sdk-eve-sandbox session):
  //
  //   const agent = new CoderAgent({ ..., workspaceId: ws.id, workspaceFiles });
  //   const { path } = await agent.uploadToWorkspace({
  //     content: await openAsBlob("./assets.zip"), path: "assets.zip",
  //   });
  //   // then ask the agent to `unzip` it with its tools.
} finally {
  // Clean up the chat we created (creates-and-archives; never touches workspaces).
  await agent.archive();
}
