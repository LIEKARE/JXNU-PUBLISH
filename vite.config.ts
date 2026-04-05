import path from 'path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { cardEditorPlugin } from './server/card-editor-plugin';

const buildVersion = new Date().toISOString().replace(/[:.]/g, '-');

function swVersionPlugin(): Plugin {
  return {
    name: 'sw-version',
    async closeBundle() {
      const fs = await import('node:fs/promises');
      const swPath = path.resolve(__dirname, 'dist', 'sw.js');
      try {
        const content = await fs.readFile(swPath, 'utf8');
        await fs.writeFile(swPath, content.replace('__BUILD_VERSION__', buildVersion), 'utf8');
      } catch {}
    },
  };
}

export default defineConfig(() => {
  return {
    define: {
      __BUILD_TIME__: JSON.stringify(buildVersion),
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [react(), cardEditorPlugin(), swVersionPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            'react-vendor': ['react', 'react-dom'],
            'ui-vendor': ['framer-motion', 'lucide-react', 'recharts'],
          }
        }
      },
      chunkSizeWarningLimit: 500,
    }
  };
});
