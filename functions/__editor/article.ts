/// <reference types="@cloudflare/workers-types" />

import { jsonResponse, loadDraftFromGitHub, withEditorAuth, type EditorEnv } from '../_lib/card-editor';

export const onRequestGet: PagesFunction<EditorEnv> = async (context) => {
  const denied = withEditorAuth(context.request, context.env);
  if (denied) return denied;

  try {
    const url = new URL(context.request.url);
    const guid = String(url.searchParams.get('guid') || '');
    const schoolSlug = String(url.searchParams.get('schoolSlug') || '');
    const draft = await loadDraftFromGitHub(context.env, guid, schoolSlug);
    return jsonResponse({ ok: true, draft });
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : '加载编辑数据失败' }, { status: 500 });
  }
};
