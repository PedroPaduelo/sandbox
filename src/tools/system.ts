/**
 * Tools de instalação de stacks on-demand.
 *
 * Rodam FORA do bwrap (direto no container como root) porque:
 *   - apt-get precisa escrever em /var/lib/dpkg, /usr/bin, /etc — o bwrap
 *     binda esses paths read-only.
 *   - installers oficiais (rustup, swift.org tarball) também escrevem em
 *     locais que o uid 1001 dentro do bwrap não acessa.
 *
 * O agent decide o que instalar baseado no projeto que o usuário quer criar.
 * O sandbox-agent roda como root — então apt-get / wget / tar funcionam.
 *
 * Pacotes instalados ficam disponíveis automaticamente pros próximos
 * run_command/start_process porque /usr é bindado read-only no bwrap, então
 * binários novos aparecem no PATH dos filhos.
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const okJson = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj) }] });
const errResp = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true });

function runHostCmd(
  bin: string,
  args: string[],
  opts: { timeoutSec?: number; input?: string } = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, (opts.timeoutSec ?? 600) * 1000);
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
    proc.on('error', (e) => {
      clearTimeout(timeout);
      resolve({ exitCode: -1, stdout: '', stderr: e.message, timedOut });
    });
    if (opts.input) {
      proc.stdin.write(opts.input);
      proc.stdin.end();
    }
  });
}

export function registerSystemTools(server: McpServer): void {
  server.registerTool(
    'sys_install',
    {
      description:
        'Instala pacotes apt no container pra adicionar runtimes/toolchains ' +
        'que o projeto do usuário precisa. Só chame se o stack NÃO estiver já disponível. ' +
        'Exemplos típicos:\n' +
        '  • Java: ["openjdk-21-jdk-headless", "maven"] ou + "gradle"\n' +
        '  • Go: ["golang-go"]\n' +
        '  • PHP: ["php-cli", "php-mbstring", "php-xml", "php-curl", "php-zip", "composer"]\n' +
        '  • Ruby: ["ruby-full"]\n' +
        '  • R: ["r-base"]\n' +
        '  • Lua: ["lua5.4", "luarocks"]\n' +
        '  • Elixir/Erlang: ["elixir"]\n' +
        '  • Haskell: ["ghc", "cabal-install"]\n' +
        '  • Clojure: ["clojure"]\n' +
        '  • Groovy: ["groovy"]\n' +
        '  • OCaml: ["ocaml", "opam"]\n' +
        '  • Libs de sistema: qualquer pacote Debian Bookworm.\n\n' +
        'Pra stacks que NÃO têm no apt (Rust, Swift, Dart, Julia, Kotlin, Deno, Bun, .NET), ' +
        'use `sys_install_script` com o nome do runtime.',
      inputSchema: {
        packages: z
          .array(z.string().min(1))
          .min(1)
          .max(30)
          .describe('Lista de nomes de pacotes apt Debian'),
      },
    },
    async ({ packages }) => {
      // apt-get update (pode ter lists limpos)
      const upd = await runHostCmd('apt-get', ['update', '-qq'], { timeoutSec: 120 });
      if (upd.exitCode !== 0) {
        return errResp(`apt-get update falhou: ${upd.stderr.slice(-800)}`);
      }
      const install = await runHostCmd(
        'apt-get',
        ['install', '-y', '--no-install-recommends', ...packages],
        { timeoutSec: 600 },
      );
      return okJson({
        packages,
        exitCode: install.exitCode,
        stdout: install.stdout.slice(-4000),
        stderr: install.stderr.slice(-2000),
        timedOut: install.timedOut,
      });
    },
  );

  server.registerTool(
    'sys_install_script',
    {
      description:
        'Instala runtime via installer oficial (paths que o apt Debian não cobre). ' +
        'Roda o script de instalação correspondente e deixa os binários no PATH. ' +
        'Runtimes suportados:\n' +
        '  • "rust"   — rustup (Rust + Cargo, toolchain stable)\n' +
        '  • "deno"   — Deno (runtime JS/TS)\n' +
        '  • "bun"    — Bun (runtime JS alternativo ao Node)\n' +
        '  • "dotnet" — .NET SDK 8 (C#/F#/VB) via repo Microsoft\n' +
        '  • "kotlin" — Kotlin compiler (JetBrains)\n' +
        '  • "dart"   — Dart SDK (Google)\n' +
        '  • "swift"  — Swift 5.10 for Linux\n' +
        '  • "julia"  — Julia 1.10\n',
      inputSchema: {
        runtime: z.enum(['rust', 'deno', 'bun', 'dotnet', 'kotlin', 'dart', 'swift', 'julia']),
      },
    },
    async ({ runtime }) => {
      const script = INSTALLERS[runtime];
      const result = await runHostCmd('bash', ['-c', script], { timeoutSec: 900 });
      return okJson({
        runtime,
        exitCode: result.exitCode,
        stdout: result.stdout.slice(-3000),
        stderr: result.stderr.slice(-2000),
        timedOut: result.timedOut,
      });
    },
  );
}

const INSTALLERS: Record<string, string> = {
  rust: `
    export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \\
      | sh -s -- -y --default-toolchain stable --profile minimal --no-modify-path
    chmod -R a+rX /opt/rustup /opt/cargo
    ln -sf /opt/cargo/bin/cargo /usr/local/bin/cargo
    ln -sf /opt/cargo/bin/rustc /usr/local/bin/rustc
    ln -sf /opt/cargo/bin/rustup /usr/local/bin/rustup
    rustc --version && cargo --version
  `,
  deno: `
    export DENO_INSTALL=/opt/deno PATH=/opt/deno/bin:$PATH
    curl -fsSL https://deno.land/install.sh | sh -s -- --yes
    chmod -R a+rX /opt/deno
    ln -sf /opt/deno/bin/deno /usr/local/bin/deno
    deno --version
  `,
  bun: `
    export BUN_INSTALL=/opt/bun PATH=/opt/bun/bin:$PATH
    curl -fsSL https://bun.sh/install | bash
    chmod -R a+rX /opt/bun
    ln -sf /opt/bun/bin/bun /usr/local/bin/bun
    bun --version
  `,
  dotnet: `
    wget -q https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb -O /tmp/ms.deb
    dpkg -i /tmp/ms.deb && rm /tmp/ms.deb
    apt-get update && apt-get install -y --no-install-recommends dotnet-sdk-8.0
    rm -rf /var/lib/apt/lists/*
    dotnet --info | head -5
  `,
  kotlin: `
    wget -q https://github.com/JetBrains/kotlin/releases/download/v2.0.20/kotlin-compiler-2.0.20.zip -O /tmp/kotlin.zip
    unzip -q /tmp/kotlin.zip -d /opt/ && rm /tmp/kotlin.zip
    chmod -R a+rX /opt/kotlinc
    ln -sf /opt/kotlinc/bin/kotlin /usr/local/bin/kotlin
    ln -sf /opt/kotlinc/bin/kotlinc /usr/local/bin/kotlinc
    kotlinc -version
  `,
  dart: `
    wget -q https://storage.googleapis.com/dart-archive/channels/stable/release/3.5.4/sdk/dartsdk-linux-x64-release.zip -O /tmp/dart.zip
    unzip -q /tmp/dart.zip -d /opt/ && rm /tmp/dart.zip
    chmod -R a+rX /opt/dart-sdk
    ln -sf /opt/dart-sdk/bin/dart /usr/local/bin/dart
    dart --version
  `,
  swift: `
    apt-get update && apt-get install -y --no-install-recommends \\
      libncurses5 libpython3-dev libxml2 libz3-4 libbsd0 tzdata libatomic1
    rm -rf /var/lib/apt/lists/*
    wget -q https://download.swift.org/swift-5.10.1-release/debian12/swift-5.10.1-RELEASE/swift-5.10.1-RELEASE-debian12.tar.gz -O /tmp/swift.tgz
    tar -C /opt -xzf /tmp/swift.tgz && rm /tmp/swift.tgz
    chmod -R a+rX /opt/swift-5.10.1-RELEASE-debian12
    ln -sf /opt/swift-5.10.1-RELEASE-debian12/usr/bin/swift /usr/local/bin/swift
    ln -sf /opt/swift-5.10.1-RELEASE-debian12/usr/bin/swiftc /usr/local/bin/swiftc
    swift --version
  `,
  julia: `
    wget -q https://julialang-s3.julialang.org/bin/linux/x64/1.10/julia-1.10.5-linux-x86_64.tar.gz -O /tmp/julia.tgz
    tar -C /opt -xzf /tmp/julia.tgz && rm /tmp/julia.tgz
    chmod -R a+rX /opt/julia-1.10.5
    ln -sf /opt/julia-1.10.5/bin/julia /usr/local/bin/julia
    julia --version
  `,
};
