import path from 'node:path';

export function createSetupAreas(root, platform = process.platform) {
  const commandSuffix = platform === 'win32' ? '.cmd' : '';
  return {
    server: {
      label: '服务端',
      dir: path.join(root, 'server'),
      manifests: ['package.json', 'package-lock.json'],
      criticalPaths: [
        path.join(root, 'server', 'node_modules', '.bin', `tsx${commandSuffix}`),
        path.join(root, 'server', 'node_modules', '.bin', `tsc${commandSuffix}`),
      ],
      verify: [['run', 'contracts:check'], ['run', 'typecheck']],
    },
    client: {
      label: '客户端',
      dir: path.join(root, 'client'),
      manifests: ['package.json', 'package-lock.json'],
      criticalPaths: [
        path.join(root, 'client', 'node_modules', '.bin', `vite${commandSuffix}`),
        path.join(root, 'client', 'node_modules', '.bin', `tsc${commandSuffix}`),
        path.join(root, 'client', 'node_modules', '@vitejs', 'plugin-react', 'dist', 'index.js'),
        path.join(root, 'client', 'node_modules', '@babel', 'core', 'package.json'),
      ],
      verify: [['run', 'build:release']],
    },
  };
}
