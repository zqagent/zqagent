/**
 * 官网下载链接必须指回发布清单里的**真实文件名**。
 *
 * 背景：CI 里各平台是不同的作业、在不同时刻构建的，同一版本下时间戳互不相同
 * （实测 0.2.37：linux 065857/065901、macos 065837/070056、windows 083532）。
 *
 * 早先的实现只从清单里取**一个**时间戳（`find(Boolean)`），再用它拼所有平台的
 * 文件名，结果只有恰好匹配的那一个平台能下载，其余全是 404——用户点 macOS
 * 下载会拿到 `zqagent-macos-x64-v0.2.37-20261023-083532`（windows 的时间戳），
 * 服务器返回 404，浏览器报「无法提取文件」。
 *
 * 这里锁住两点：优先用清单 URL；没有 URL 时才回退到拼装。
 */
import { describe, expect, it } from "vitest";
import {
  buildRecommendation,
  desktopInstallerName,
} from "../../site/docs/.vitepress/theme/lib/detectOS.js";

const LABELS = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  appleSilicon: "Apple silicon",
  intel: "Intel",
  armDevice: "ARM device",
  bit64: "64-bit",
};

/** 同一版本、各平台时间戳不同的真实形态 */
const URLS = {
  "linux-arm64": "https://example.test/v0.2.37/zqagent-linux-arm64-v0.2.37-20261023-065857",
  "linux-x64": "https://example.test/v0.2.37/zqagent-linux-x64-v0.2.37-20261023-065901",
  "macos-arm64": "https://example.test/v0.2.37/zqagent-macos-arm64-v0.2.37-20261023-065837",
  "macos-x64": "https://example.test/v0.2.37/zqagent-macos-x64-v0.2.37-20261023-070056",
  "windows-x64": "https://example.test/v0.2.37/zqagent-windows-x64-v0.2.37-20261023-083532.exe",
};

const opts = (urls?: Record<string, string>) => ({
  version: "0.2.37",
  buildStamp: "20261023-083532",
  baseUrl: "https://example.test",
  labels: LABELS,
  ...(urls ? { urls } : {}),
});

describe("官网下载链接", () => {
  it("macOS x64 用清单里的地址，而不是拿别的平台的时间戳拼", () => {
    const r = buildRecommendation({ platform: "macos", arch: "x64" }, opts(URLS));
    expect(r.url).toBe(URLS["macos-x64"]);
    // 拼装会得到 ...-083532（windows 的时间戳），即用户遇到的那个 404
    expect(r.url).not.toContain("083532");
  });

  it("每个平台都拿到自己的真实时间戳", () => {
    const cases: Array<[string, string, string]> = [
      ["macos", "arm64", "065837"],
      ["macos", "x64", "070056"],
      ["linux", "x64", "065901"],
      ["linux", "arm64", "065857"],
      ["windows", "x64", "083532"],
    ];
    for (const [platform, arch, stamp] of cases) {
      const r = buildRecommendation({ platform, arch }, opts(URLS));
      expect(r.url, `${platform}-${arch}`).toContain(stamp);
    }
  });

  it("备选架构链接同样取自清单", () => {
    // Apple Silicon 机器上，备选链接应是 Intel 包
    const r = buildRecommendation({ platform: "macos", arch: "arm64" }, opts(URLS));
    expect(r.altUrl).toBe(URLS["macos-x64"]);
  });

  it("清单缺该平台时回退到拼装（兼容旧调用）", () => {
    const r = buildRecommendation({ platform: "macos", arch: "x64" }, opts());
    expect(r.url).toBe(
      "https://example.test/v0.2.37/zqagent-macos-x64-v0.2.37-20261023-083532",
    );
  });
});

/**
 * macOS 用户必须拿到 `.dmg`，不能是 CLI 裸二进制。
 *
 * CLI 产物在 macOS 上不带扩展名（`zqagent-macos-x64-v0.2.37-...`），浏览器存成
 * 无后缀文件、双击也不会安装，用户的反馈就是「扩展名 dmg 没体现出来，不能点击
 * 安装」。可双击安装的形态只有桌面版 `.dmg`。
 */
describe("macOS 下载形态", () => {
  const FILES = {
    "macos-universal": { dmg: "ZQAgent-macos-universal-v0.2.37-20261023-070141.dmg" },
    "windows-x64": { setup: "ZQAgent-windows-x64-v0.1.1-20261019-141212-setup.exe" },
    "linux-x64": { deb: "ZQAgent-linux-x64-v0.2.37-20261023-070228.deb" },
  };

  it("有 universal 包时两个架构都给同一个 dmg", () => {
    for (const arch of ["arm64", "x64"]) {
      expect(desktopInstallerName(FILES, "macos", arch)).toBe(FILES["macos-universal"].dmg);
    }
  });

  it("只有分架构包时按架构回退", () => {
    const split = {
      "macos-arm64": { dmg: "ZQAgent-macos-arm64-v0.2.30-1.dmg" },
      "macos-x64": { dmg: "ZQAgent-macos-x64-v0.2.30-2.dmg" },
    };
    expect(desktopInstallerName(split, "macos", "arm64")).toBe("ZQAgent-macos-arm64-v0.2.30-1.dmg");
    expect(desktopInstallerName(split, "macos", "x64")).toBe("ZQAgent-macos-x64-v0.2.30-2.dmg");
  });

  it("macOS 的安装包名一定以 .dmg 结尾", () => {
    const name = desktopInstallerName(FILES, "macos", "arm64");
    expect(name.endsWith(".dmg")).toBe(true);
  });

  it("清单里没有 macOS 桌面包时返回空串（界面回退到说明页）", () => {
    expect(desktopInstallerName({ "windows-x64": FILES["windows-x64"] }, "macos", "arm64")).toBe("");
  });
});
