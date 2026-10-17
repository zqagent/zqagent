/**
 * `encoding` 的构建期桩模块（仅用于 SEA 单文件构建）。
 *
 * node-fetch@2 在模块顶层做 `convert = require("encoding").convert`（可选依赖，
 * 包在 try/catch 里），但 `encoding` 并未安装，esbuild 因此把它保留成运行时
 * `require`。而 SEA 内嵌脚本的 `require` 只支持内置模块，运行到这一句时 Node 会
 * 打印 "only supports loading built-in modules" 警告并抛错（被 node-fetch 的
 * try/catch 吞掉）。
 *
 * 这里提供一个空实现，并在 tsup.sea.config.ts 里把 `encoding` alias 到本文件，
 * 让 esbuild 直接内联，彻底消除这次运行时 require。node-fetch 只在需要非 UTF-8
 * charset 转码时才使用 `convert`；不提供时其行为与「require 抛错被 catch」完全
 * 一致，故不改变现有功能。
 */
module.exports = {};
