// 服务启动共享逻辑：gui.mjs（Edge 窗口/浏览器模式）与 electron/main.mjs 共用
import { createApp } from './server.mjs';

/** 监听指定地址（默认 127.0.0.1；--lan 传 0.0.0.0），端口被占则自动 +1，返回 { url, close } */
export async function startServer(preferredPort = 8321, opts = {}, host = '127.0.0.1') {
  const server = createApp(opts);

  function listen(port) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onOk);
        reject(err);
      };
      const onOk = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onOk);
      server.listen(port, host);
    });
  }

  let port = preferredPort;
  for (let i = 0; i < 20; i++) {
    try {
      await listen(port);
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      port++;
    }
  }

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
