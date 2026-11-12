/** Synthetic, model-backed media cases for probe-native-scenarios.mjs. No credentials. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";

export function colorPng(rgb) {
  const width = 160,
    height = 120;
  const row = Buffer.from([
    0,
    ...Array.from({ length: width }, () => rgb).flat(),
  ]);
  const crc = (data) => {
    let value = 0xffffffff;
    for (const byte of data) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++)
        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]);
    const size = Buffer.alloc(4),
      sum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([size, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function textPdf(text) {
  assert.match(text, /^[a-zA-Z0-9 -]+$/);
  const stream = `BT /F1 20 Tf 40 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let result = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}

const attachment = (name, mediaType, bytes) => ({
  name,
  mediaType,
  data: Buffer.from(bytes).toString("base64"),
});
const word = (text, expected) =>
  assert.match(text.toLowerCase(), new RegExp(`\\b${expected}\\b`));

export function nativeMediaScenarios(profile) {
  const cases = [];
  let calls = 0;
  const image = colorPng([0, 0, 255]);
  cases.push({
    name: "tool-image",
    input:
      "Call probe_picture exactly once. Inspect the returned picture and answer with its dominant color in English. Use the native image display or vision tool if required. Do not infer the color from names or modify files.",
    tools: [
      {
        name: "probe_picture",
        description:
          "Return the synthetic picture to inspect." +
          (profile.kernel === "codex"
            ? " In native JavaScript execution the single image result is a data URL string. Display it using image(await tools.probe_picture({})); do not assume an MCP content array."
            : ""),
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: async () => {
          calls++;
          return {
            success: true,
            contentItems: [
              {
                type: "inputImage",
                imageUrl: `data:image/png;base64,${image.toString("base64")}`,
              },
            ],
          };
        },
      },
    ],
    verify: ({ run }) => {
      assert.equal(calls, 1, "image_tool_call_count");
      word(run.answer, "blue");
    },
  });
  cases.push({
    name: "two-images",
    input:
      "Inspect both attached pictures. Return only the dominant colors in their attachment order, separated by a comma, in English.",
    attachments: [
      attachment("first.png", "image/png", colorPng([255, 0, 0])),
      attachment("second.png", "image/png", colorPng([0, 0, 255])),
    ],
    verify: ({ run }) =>
      assert.match(run.answer.toLowerCase(), /\bred\b[\s\S]*\bblue\b/),
  });
  if (["hermes", "kimi", "opencode"].includes(profile.kernel)) {
    for (const format of ["txt", "json", "csv"]) {
      const receipt = randomUUID();
      const text =
        format === "json"
          ? JSON.stringify({ receipt, label: "附件文字验证" })
          : format === "csv"
            ? `key,value\nreceipt,${receipt}\nlabel,附件文字验证\n`
            : `附件文字验证\nreceipt=${receipt}\n`;
      cases.push({
        name: `file-${format}`,
        input:
          "Read the attached file with native read tools if needed. Return the exact receipt value and the Chinese label from its contents. Do not modify files or run shell commands.",
        attachments: [
          attachment(
            `资料 ${randomUUID()}.${format}`,
            { txt: "text/plain", json: "application/json", csv: "text/csv" }[
              format
            ],
            text,
          ),
        ],
        verify: ({ run }) => {
          assert.ok(run.answer.includes(receipt), "file_receipt_missing");
          assert.ok(run.answer.includes("附件文字验证"), "utf8_label_missing");
        },
      });
    }
  }
  if (["claude", "opencode", "hermes", "openclaw"].includes(profile.kernel)) {
    const receipt = randomUUID();
    cases.push({
      name: "pdf-and-image",
      input:
        "Read the attached PDF and inspect the attached picture. Return the exact receipt printed in the PDF and the dominant picture color in English. Use native read or PDF tools if needed; do not modify files.",
      attachments: [
        attachment("document.pdf", "application/pdf", textPdf(receipt)),
        attachment("picture.png", "image/png", colorPng([0, 0, 255])),
      ],
      verify: ({ run }) => {
        assert.ok(run.answer.includes(receipt), "pdf_receipt_missing");
        word(run.answer, "blue");
      },
    });
  }
  return cases;
}
