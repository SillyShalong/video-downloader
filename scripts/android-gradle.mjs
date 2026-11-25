#!/usr/bin/env node
// 跨平台调用 Android 工程的 Gradle 包装器（Windows 上是 gradlew.bat，类 Unix 上是 ./gradlew）。
//
//   node scripts/android-gradle.mjs :app:testDebugUnitTest --no-daemon
//   node scripts/android-gradle.mjs assembleDebug
//
// 需要 JDK 21（java 目标版本）和 Android SDK（ANDROID_HOME 环境变量，或 android/local.properties 里的 sdk.dir）。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ANDROID_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'android');
const SCRIPT_URL = import.meta.url;

/** 运行一条 gradle 命令，返回 { status, stdout, stderr }（不抛异常，由调用方决定怎么处理） */
export function runGradle(args, { env = process.env, quiet = false } = {}) {
  const isWin = process.platform === 'win32';
  const gradlew = path.join(ANDROID_DIR, isWin ? 'gradlew.bat' : 'gradlew');
  const gradleArgs = [...args, ...(quiet ? ['-q'] : [])];
  // Windows 上 .bat 必须经过 shell：自己拼好整条命令再交给 shell（避免「shell + args 数组」的转义隐患）
  const command = isWin ? [gradlew, ...gradleArgs].map((x) => `"${x}"`).join(' ') : gradlew;
  const r = spawnSync(command, isWin ? [] : gradleArgs, {
    cwd: ANDROID_DIR,
    encoding: 'utf8',
    windowsHide: true,
    shell: isWin,
    env,
    maxBuffer: 256 * 1024 * 1024,
  });
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

// 作为脚本直接运行时（不是被 import）才执行命令行传来的 gradle 任务
if (process.argv[1] && SCRIPT_URL === pathToFileURL(path.resolve(process.argv[1])).href) {
  const r = runGradle(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) console.error('无法启动 Gradle：', r.error.message);
  process.exitCode = r.status;
}
