import { createInterface } from "node:readline/promises";
import type { InteractionHandler } from "../interactions.js";

export const terminalInteraction: InteractionHandler = async (
  request,
  context,
) => {
  if (!process.stdin.isTTY) return { action: "cancel" };
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ask = (text: string) => rl.question(text, { signal: context.signal });
  try {
    console.error(request.title);
    if (request.permissions)
      console.error(JSON.stringify(request.permissions, null, 2));
    if (request.kind === "approval") {
      request.choices?.forEach((c, i) =>
        console.error(`${i + 1}. ${c.label}${c.scope ? ` (${c.scope})` : ""}`),
      );
      const selected =
        request.choices?.[
          Number(await ask("Choose a number (Enter cancels): ")) - 1
        ];
      return selected ? { choice: selected.id } : { action: "cancel" };
    }
    if (request.kind === "questions") {
      const answers: Record<string, string | string[]> = {};
      for (const q of request.questions ?? []) {
        if (q.secret)
          throw new Error("secret_question_requires_product_handler");
        console.error(q.title);
        q.options?.forEach((o) =>
          console.error(
            `- ${o.label}${o.description ? `: ${o.description}` : ""}`,
          ),
        );
        const text = await ask(
          q.multiple ? "Answers (comma separated): " : "Answer: ",
        );
        answers[q.id] = q.multiple
          ? text.split(",").map((s) => s.trim())
          : text;
      }
      return { answers };
    }
    if (request.kind === "url") {
      console.error(`Open in your browser: ${request.url}`);
      return {
        action:
          (await ask("Completed? [y/N] ")).toLowerCase() === "y"
            ? "accept"
            : "cancel",
      };
    }
    if (request.kind === "form") {
      console.error(JSON.stringify(request.schema, null, 2));
      const text = await ask(
        "Enter the requested fields as JSON (Enter cancels): ",
      );
      return text
        ? { action: "accept", content: JSON.parse(text) }
        : { action: "cancel" };
    }
    console.error(
      "This native interaction needs an application-specific handler.",
    );
    return { action: "cancel" };
  } finally {
    rl.close();
  }
};
