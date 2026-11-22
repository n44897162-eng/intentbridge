#!/usr/bin/env node
/**
 * Reproducible platform builds for the slices that can compile on this host.
 * Missing toolchains are reported as NOT_RUN (never as success), and a present
 * but failing toolchain fails closed.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const env = { ...process.env };
const home = env.HOME ?? '/root';

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  return spawnSync(command, args, {
    cwd: root,
    env: options.env ?? env,
    stdio: 'inherit',
    timeout: 900_000,
  });
}

function findDotnet() {
  const candidates = ['/usr/share/dotnet/dotnet', resolve(home, '.dotnet/dotnet')];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  const which = spawnSync('dotnet', ['--version'], { encoding: 'utf8' });
  return which.status === 0 ? 'dotnet' : null;
}

function buildWindows() {
  const dotnet = findDotnet();
  if (!dotnet) {
    console.log('WINDOWS BUILD: NOT_RUN (dotnet not found)');
    return;
  }
  const fixture = run(dotnet, [
    'build',
    'fixtures/windows-fixture/IntentBridge.Fixture.csproj',
    '-c',
    'Release',
  ]);
  const executor = run(dotnet, [
    'build',
    'apps/windows-executor/IntentBridge.Executor.csproj',
    '-c',
    'Release',
  ]);
  if (fixture.status !== 0 || executor.status !== 0)
    process.exit(fixture.status || executor.status || 1);
  console.log('WINDOWS BUILD: PASS (compile only; UIA runtime requires Windows)');
}

function buildAndroid() {
  const androidHome = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT ?? '/opt/android-sdk';
  const gradle = [
    env.GRADLE_COMMAND,
    resolve(androidHome, '..', 'gradle/gradle-8.9/bin/gradle'),
    '/opt/gradle/gradle-8.9/bin/gradle',
    'gradle',
  ]
    .filter(Boolean)
    .find((candidate) => candidate === 'gradle' || existsSync(candidate));
  if (!existsSync(androidHome) || !gradle) {
    console.log('ANDROID BUILD: NOT_RUN (Android SDK or Gradle not found)');
    return;
  }
  const javaHome =
    env.JAVA_HOME ??
    spawnSync('bash', ['-lc', 'dirname $(dirname $(readlink -f $(which java)))'], {
      encoding: 'utf8',
    }).stdout.trim();
  const androidEnv = {
    ...env,
    ANDROID_HOME: androidHome,
    ANDROID_SDK_ROOT: androidHome,
    JAVA_HOME: javaHome,
    GRADLE_USER_HOME: env.GRADLE_USER_HOME ?? resolve(home, '.gradle'),
  };
  const ndk = resolve(androidHome, 'ndk/29.0.14206865/toolchains/llvm/prebuilt/linux-x86_64/bin');
  const rustupTargets = spawnSync('rustup', ['target', 'list', '--installed'], {
    encoding: 'utf8',
  });
  const installed = rustupTargets.stdout ?? '';
  const jniReady = installed.includes('aarch64-linux-android') && existsSync(ndk);
  if (jniReady) {
    // Never package stale native libraries from an earlier build.
    rmSync(resolve(root, 'apps/android-app/app/src/main/jniLibs'), {
      recursive: true,
      force: true,
    });
    const cargoEnv = {
      ...androidEnv,
      PATH: `${ndk}:${resolve(home, '.cargo/bin')}:${androidEnv.PATH ?? ''}`,
    };
    const arm = run(
      'cargo',
      ['build', '-p', 'ib-runtime', '--release', '--target', 'aarch64-linux-android'],
      { env: cargoEnv },
    );
    const x86 = installed.includes('x86_64-linux-android')
      ? run(
          'cargo',
          ['build', '-p', 'ib-runtime', '--release', '--target', 'x86_64-linux-android'],
          { env: cargoEnv },
        )
      : { status: 0 };
    if (arm.status !== 0 || x86.status !== 0) process.exit(1);
    mkdirSync(resolve(root, 'apps/android-app/app/src/main/jniLibs/arm64-v8a'), {
      recursive: true,
    });
    copyFileSync(
      resolve(root, 'target/aarch64-linux-android/release/libib_runtime.so'),
      resolve(root, 'apps/android-app/app/src/main/jniLibs/arm64-v8a/libib_runtime.so'),
    );
    if (installed.includes('x86_64-linux-android')) {
      mkdirSync(resolve(root, 'apps/android-app/app/src/main/jniLibs/x86_64'), { recursive: true });
      copyFileSync(
        resolve(root, 'target/x86_64-linux-android/release/libib_runtime.so'),
        resolve(root, 'apps/android-app/app/src/main/jniLibs/x86_64/libib_runtime.so'),
      );
    }
  } else {
    console.log('ANDROID JNI: NOT_RUN (Rust Android target or NDK missing)');
  }
  const app = run(
    gradle,
    ['-p', 'apps/android-app', ':app:assembleDebug', '--no-daemon', '--console=plain'],
    { env: androidEnv },
  );
  const fixture = run(
    gradle,
    ['-p', 'fixtures/android-fixture', ':app:assembleDebug', '--no-daemon', '--console=plain'],
    { env: androidEnv },
  );
  if (app.status !== 0 || fixture.status !== 0) process.exit(app.status || fixture.status || 1);
  if (!jniReady) {
    console.error('ANDROID BUILD: FAILED (JNI unavailable; APK would fail System.loadLibrary)');
    process.exit(1);
  }
  console.log('ANDROID BUILD: PASS (APK compile/package; device runtime NOT_RUN)');
}

buildWindows();
buildAndroid();
