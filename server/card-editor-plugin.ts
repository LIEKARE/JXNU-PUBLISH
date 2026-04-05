import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import type { Plugin } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CARD_DIR = path.join(ROOT, 'content', 'card');
const ATTACHMENT_DIR = path.join(ROOT, 'content', 'attachments');

type EditorAttachment = {
  name: string;
  url: string;
  type?: string;
  pendingUpload?: {
    contentType?: string;
    base64: string;
  };
};

type UploadPayload = {
  name: string;
  contentType?: string;
  base64: string;
};

type EditorPayload = {
  guid: string;
  schoolSlug: string;
  title: string;
  description: string;
  markdown: string;
  attachments: EditorAttachment[];
};

const json = (value: string) => JSON.stringify(value);

function isSafeSlug(value: string) {
  return /^[a-z0-9-]+$/i.test(value);
}

function normalizeGuid(value: string) {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('无效卡片 ID');
  }
  return trimmed;
}

function normalizeSchoolSlug(value: string) {
  const trimmed = String(value || '').trim();
  if (!isSafeSlug(trimmed)) {
    throw new Error('无效学院标识');
  }
  return trimmed;
}

function toPosixPath(value: string) {
  return value.split(path.sep).join('/');
}

function resolveCardPath(guid: string, schoolSlug: string) {
  const safeGuid = normalizeGuid(guid);
  const safeSchoolSlug = normalizeSchoolSlug(schoolSlug);
  const filePath = path.resolve(CARD_DIR, safeSchoolSlug, `${safeGuid}.md`);
  const relative = path.relative(CARD_DIR, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('卡片路径越界');
  }
  return filePath;
}

function sanitizeFileName(name: string) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || `attachment-${Date.now()}`;
}

function normalizeAttachmentUrl(url: string) {
  const trimmed = String(url || '').trim();
  if (!trimmed) {
    throw new Error('附件地址不能为空');
  }
  if (trimmed.includes('..')) {
    throw new Error('附件地址非法');
  }
  return trimmed;
}

function normalizeAttachments(value: unknown): EditorAttachment[] {
  if (!Array.isArray(value)) {
    throw new Error('附件格式不正确');
  }

  return value.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error('附件格式不正确');
    }
    const attachment = item as Record<string, unknown>;
    const name = String(attachment.name || '').trim();
    const url = normalizeAttachmentUrl(String(attachment.url || '').trim());
    const type = String(attachment.type || '').trim();
    const pendingUpload = attachment.pendingUpload && typeof attachment.pendingUpload === 'object'
      ? {
          contentType: String((attachment.pendingUpload as Record<string, unknown>).contentType || '').trim() || undefined,
          base64: String((attachment.pendingUpload as Record<string, unknown>).base64 || '').trim(),
        }
      : undefined;
    if (!name) {
      throw new Error('附件名称不能为空');
    }
    const normalized = type ? { name, url, type } : { name, url };
    return pendingUpload?.base64 ? { ...normalized, pendingUpload } : normalized;
  });
}

function parseJsonBody<T>(req: NodeJS.ReadableStream): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: { statusCode: number; setHeader(name: string, value: string): void; end(body?: string): void }, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(`${JSON.stringify(payload)}\n`);
}

function foldBlock(value: string) {
  const lines = String(value || '').replace(/\r\n/g, '\n').split('\n');
  if (!lines.length) {
    return '  ';
  }
  return lines.map((line) => `  ${line}`).join('\n');
}

function buildFrontmatter(data: Record<string, unknown>) {
  const attachments = Array.isArray(data.attachments) ? data.attachments as EditorAttachment[] : [];
  const lines = [
    '---',
    `title: ${json(String(data.title || ''))}`,
    'description: >-',
    foldBlock(String(data.description || '')),
    `category: ${json(String(data.category || '其它分类'))}`,
    `tags: [${(Array.isArray(data.tags) ? data.tags : []).map((item) => json(String(item))).join(', ')}]`,
    `start_at: ${json(String(data.start_at || ''))}`,
    `end_at: ${json(String(data.end_at || ''))}`,
    `id: ${json(String(data.id || ''))}`,
    `school_slug: ${json(String(data.school_slug || ''))}`,
    `published: ${json(String(data.published || ''))}`,
    `pinned: ${Boolean(data.pinned) ? 'true' : 'false'}`,
    `cover: ${json(String(data.cover || ''))}`,
    `badge: ${json(String(data.badge || ''))}`,
    `extra_url: ${json(String(data.extra_url || ''))}`,
    'source:',
    `  channel: ${json(String((data.source as Record<string, unknown> | undefined)?.channel || ''))}`,
    `  sender: ${json(String((data.source as Record<string, unknown> | undefined)?.sender || ''))}`,
  ];

  if (!attachments.length) {
    lines.push('attachments: []');
  } else {
    lines.push('attachments:');
    for (const attachment of attachments) {
      lines.push(`  - name: ${json(attachment.name)}`);
      lines.push(`    url: ${json(attachment.url)}`);
      if (attachment.type) {
        lines.push(`    type: ${json(attachment.type)}`);
      }
    }
  }

  lines.push('---');
  return lines.join('\n');
}

async function compileContent() {
  const nodeExec = process.execPath;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(nodeExec, ['scripts/compile-content.mjs'], {
      cwd: ROOT,
      stdio: 'pipe',
      env: process.env,
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `build:content exited with code ${code}`));
    });
  });
}

async function loadEditorDraft(guid: string, schoolSlug: string) {
  const filePath = resolveCardPath(guid, schoolSlug);
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = matter(raw);
  const attachments = normalizeAttachments(parsed.data.attachments || []);
  return {
    guid,
    schoolSlug,
    title: String(parsed.data.title || '').trim(),
    description: String(parsed.data.description || '').trim(),
    markdown: String(parsed.content || '').replace(/^\n+/, ''),
    attachments,
  };
}

async function deleteRemovedManualAttachments(guid: string, previous: EditorAttachment[], next: EditorAttachment[]) {
  const nextUrls = new Set(next.map((item) => item.url));
  const removablePrefix = `/attachments/manual/${guid}/`;
  const candidates = previous.filter((item) => item.url.startsWith(removablePrefix) && !nextUrls.has(item.url));

  await Promise.all(candidates.map(async (item) => {
    const relativePath = item.url.replace(/^\//, '');
    const target = path.resolve(ROOT, 'content', relativePath);
    const relative = path.relative(ATTACHMENT_DIR, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return;
    }
    await fs.unlink(target).catch(() => {});
  }));

  const manualDir = path.join(ATTACHMENT_DIR, 'manual', guid);
  const entries = await fs.readdir(manualDir).catch(() => [] as string[]);
  if (!entries.length) {
    await fs.rmdir(manualDir).catch(() => {});
  }
}

async function saveEditorDraft(payload: EditorPayload) {
  const filePath = resolveCardPath(payload.guid, payload.schoolSlug);
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = matter(raw);
  const previousAttachments = normalizeAttachments(parsed.data.attachments || []);
  const rawNextAttachments = normalizeAttachments(payload.attachments);
  const nextAttachments: EditorAttachment[] = [];

  for (const attachment of rawNextAttachments) {
    if (attachment.pendingUpload?.base64) {
      const uploaded = await uploadAttachments(payload.guid, [{
        name: attachment.name,
        contentType: attachment.pendingUpload.contentType,
        base64: attachment.pendingUpload.base64,
      }]);
      nextAttachments.push(uploaded[0]);
      continue;
    }
    nextAttachments.push({ name: attachment.name, url: attachment.url, type: attachment.type });
  }

  const nextData = {
    ...parsed.data,
    title: String(payload.title || '').trim(),
    description: String(payload.description || '').trim(),
    attachments: nextAttachments,
  };

  const frontmatter = buildFrontmatter(nextData);
  const markdown = String(payload.markdown || '').replace(/\r\n/g, '\n').trimEnd();
  await fs.writeFile(filePath, `${frontmatter}\n\n${markdown}\n`, 'utf8');
  await deleteRemovedManualAttachments(payload.guid, previousAttachments, nextAttachments);
  await compileContent();
}

async function uploadAttachments(guid: string, files: UploadPayload[]) {
  const safeGuid = normalizeGuid(guid);
  const targetDir = path.join(ATTACHMENT_DIR, 'manual', safeGuid);
  await fs.mkdir(targetDir, { recursive: true });

  const uploaded: EditorAttachment[] = [];
  for (const file of files) {
    const cleanedName = sanitizeFileName(file.name);
    const outputName = `${Date.now()}-${cleanedName}`;
    const outputPath = path.join(targetDir, outputName);
    const base64 = String(file.base64 || '').replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    await fs.writeFile(outputPath, buffer);
    uploaded.push({
      name: cleanedName,
      url: `/${toPosixPath(path.join('attachments', 'manual', safeGuid, outputName))}`,
      type: file.contentType || path.extname(cleanedName).slice(1),
    });
  }
  return uploaded;
}

function registerMiddleware(middlewares: { use(fn: (req: any, res: any, next: () => void) => void): void }) {
  middlewares.use((req, res, next) => {
    if (!req.url || !req.url.startsWith('/__editor/')) {
      next();
      return;
    }

    const handle = async () => {
      const requestUrl = new URL(req.url, 'http://127.0.0.1');

      if (req.method === 'GET' && requestUrl.pathname === '/__editor/article') {
        const guid = normalizeGuid(requestUrl.searchParams.get('guid') || '');
        const schoolSlug = normalizeSchoolSlug(requestUrl.searchParams.get('schoolSlug') || '');
        const draft = await loadEditorDraft(guid, schoolSlug);
        sendJson(res, 200, { ok: true, draft });
        return;
      }

      if (req.method === 'POST' && requestUrl.pathname === '/__editor/upload') {
        const body = await parseJsonBody<{ guid: string; files: UploadPayload[] }>(req);
        const guid = normalizeGuid(body.guid || '');
        const files = Array.isArray(body.files) ? body.files : [];
        const attachments = await uploadAttachments(guid, files);
        sendJson(res, 200, { ok: true, attachments });
        return;
      }

      if (req.method === 'POST' && requestUrl.pathname === '/__editor/save') {
        const body = await parseJsonBody<EditorPayload>(req);
        const payload: EditorPayload = {
          guid: normalizeGuid(body.guid || ''),
          schoolSlug: normalizeSchoolSlug(body.schoolSlug || ''),
          title: String(body.title || ''),
          description: String(body.description || ''),
          markdown: String(body.markdown || ''),
          attachments: normalizeAttachments(body.attachments || []),
        };
        await saveEditorDraft(payload);
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'Not found' });
    };

    handle().catch((error) => {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : '编辑接口失败' });
    });
  });
}

export function cardEditorPlugin(): Plugin {
  return {
    name: 'card-editor-plugin',
    configureServer(server) {
      registerMiddleware(server.middlewares);
    },
    configurePreviewServer(server) {
      registerMiddleware(server.middlewares);
    },
  };
}
