"use strict";
// EchoAnswer 根入口（保持 node server.js 启动方式不变——测试与部署均依赖）。
// P2 起装配与路由模块化：见 server/app.js（上下文）与 server/routes/*（路由）。
const { start } = require("./server/app");

const server = start();
module.exports = server;
