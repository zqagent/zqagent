/**
 * 内置 OCR MCP 测试
 *
 * 1) 经 InMemoryTransport 暴露 recognize 工具并返回可读错误；
 * 2) 引擎探测降级：无可用引擎时返回 how_to_fix；
 * 3) 注入 tesseract 桩，验证成功路径（不依赖本机二进制）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { McpClient } from "../src/index.js";
import { listBuiltinServers } from "../src/mcp/builtin/index.js";
import { recognizeOcr } from "../src/mcp/builtin/ocrEngine.js";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);

function makeTempImage(): { dir: string; image: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zqagent-ocr-test-"));
  const image = path.join(dir, "sample.png");
  fs.writeFileSync(image, PNG);
  return { dir, image };
}

describe("内置 OCR MCP", () => {
  it("注册在 builtin 表中", () => {
    expect(listBuiltinServers()).toContain("ocr");
  });

  it("经 in-memory transport 暴露 recognize 工具", async () => {
    const client = new McpClient(
      { name: "ocr", type: "builtin", builtin: "ocr" },
      { builtin: { workspace: os.tmpdir(), env: {} } },
    );
    await client.connect();
    expect(client.listTools().map((t) => t.name)).toEqual(["recognize"]);
    await client.close();
  });

  it("缺少输入时返回可读错误", async () => {
    const client = new McpClient(
      { name: "ocr", type: "builtin", builtin: "ocr" },
      {
        builtin: {
          workspace: os.tmpdir(),
          env: {},
          ocr: { platform: "linux", env: {}, which: () => null },
        },
      },
    );
    await client.connect();
    const res = (await client.callTool("recognize", {})) as {
      error: string;
      isError: boolean;
    };
    expect(res.isError).toBe(true);
    expect(res.error).toContain("缺少输入");
    await client.close();
  });
});

describe("OCR 引擎探测与降级", () => {
  it("无可用引擎时返回 how_to_fix", async () => {
    const { dir, image } = makeTempImage();
    try {
      const result = await recognizeOcr(
        { imagePath: image },
        {
          workspace: dir,
          env: {},
          ocr: {
            platform: "linux",
            env: {},
            fileExists: (p) => fs.existsSync(p),
            which: () => null,
            tmpDir: dir,
          },
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("没有可用的 OCR 引擎");
        expect(result.how_to_fix).toContain("tesseract");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("注入 tesseract 桩后返回识别文本", async () => {
    const { dir, image } = makeTempImage();
    const runs: string[] = [];
    try {
      const result = await recognizeOcr(
        { imagePath: image },
        {
          workspace: dir,
          env: {},
          ocr: {
            platform: "linux",
            env: {},
            fileExists: (p) => fs.existsSync(p),
            which: (name) =>
              name === "tesseract" ? "/usr/bin/tesseract" : null,
            run: async (command, args) => {
              runs.push([command, ...args].join(" "));
              return { stdout: "识别结果\n", stderr: "" };
            },
            tmpDir: dir,
          },
        },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.engine).toBe("tesseract");
        expect(result.text).toBe("识别结果");
      }
      expect(runs[0]).toContain("tesseract");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
