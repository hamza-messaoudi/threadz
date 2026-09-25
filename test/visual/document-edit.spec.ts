import { expect, test, type Page } from '@playwright/test';

// Editing a shared document, end to end against the harness (fake claude): the pencil, a save, an agent's
// edit from a thread arriving live, and a conflict. Desktop and phone, light and dark. The screenshots
// go to test-results/ for review; they are not compared (the flow is what is checked).

const DOC = [
  '# Search rollout plan',
  '',
  'We are moving search to the new index in three stages, starting with staff accounts in the first week of October.',
  '',
  '## Goals',
  '',
  'The new index cuts p95 latency from 420 ms to under 150 ms and removes the nightly rebuild.',
  '',
  "Relevance must not regress: the click-through rate on the first result stays within one point of today's.",
  '',
  '## Stages',
  '',
  '1. Staff accounts, behind a flag.\n2. Ten percent of traffic, with a kill switch.\n3. Everyone, once the error budget allows it.',
  '',
  '## Risks',
  '',
  'The biggest risk is the rebuild of the synonyms table, which still runs on the old cluster.',
  '',
  'Rollback takes about four minutes and is covered by the runbook.',
].join('\n');

const agentEdit = (find: string, replace: string) =>
  `@researcher tighten this\nFAKE_REPLY=Done.\\n\\n<document_edit name="rollout.md">\\n<replace>\\n${find}\\n</replace>\\n<with>\\n${replace}\\n</with>\\n</document_edit>`;

async function channelWithDocument(page: Page, name: string) {
  await page.request.post('/api/login', { data: { token: 'a'.repeat(48) } });
  const ch = await (await page.request.post('/api/conversations', { data: { kind: 'channel', name } })).json();
  const doc = await (await page.request.post(`/api/threads/${ch.rootThreadId}/documents`, { data: { name: 'rollout.md', content: DOC } })).json();
  await page.goto(`/c/${ch.id}`);
  await page.locator('.msg.doc [data-block]').first().waitFor();
  return { ch, doc };
}

const sizes = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const;

for (const size of sizes)
  for (const scheme of ['light', 'dark'] as const) {
    test(`edit a document · ${size.name} ${scheme}`, async ({ page }) => {
      // After the header's text swap (150 ms) has settled.
      const shot = async (step: string) => {
        await page.waitForTimeout(300);
        await page.screenshot({ path: `test-results/doc-edit/${size.name}-${scheme}-${step}.png` });
      };
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const { doc } = await channelWithDocument(page, `edit-${size.name}-${scheme}`);
      const head = page.locator('.msg.doc .doc-head');

      // 1. The pencil: a section on desktop (the heading's pencil), the whole text on a phone (the header's).
      if (size.name === 'desktop') {
        await page.locator('.md-doc h2', { hasText: 'Stages' }).hover();
        await shot('1-pencil');
        await page.getByRole('button', { name: 'Edit the section Stages' }).click();
      } else await head.getByRole('button', { name: 'Edit the document' }).click();
      const area = page.locator('.doc-editor-text');
      await expect(area).toBeFocused();
      await shot('2-editor');
      const text = await area.inputValue();
      await area.fill(text.replace('behind a flag.', 'behind a flag, from October 6.'));
      await area.press('ControlOrMeta+Enter');
      await expect(page.locator('.doc-editor')).toHaveCount(0);
      await expect(page.locator('.md-doc')).toContainText('behind a flag, from October 6.');
      await expect(head.locator('.doc-history-btn')).toContainText('v2');
      await shot('3-saved');

      // 2. An agent edits it from a thread on a paragraph; the channel shows the new version live.
      const thread = await (await page.request.post('/api/threads', { data: { message_id: doc.id, block_index: 9 } })).json();
      await page.request.post(`/api/threads/${thread.id}/messages`, {
        data: { text: agentEdit('Rollback takes about four minutes and is covered by the runbook.', 'Rollback takes about four minutes and is owned by the search on-call.'), mentions: [{ kind: 'agent', id: 'researcher', start: 0, end: 11 }] },
      });
      await expect(page.locator('.md-doc')).toContainText('owned by the search on-call');
      await expect(page.locator('.doc-edit-note').last()).toContainText('@researcher edited rollout.md · version 3 · from a thread · 1 thread’s passage changed');
      await expect(page.locator('.thread-badge-changed')).toHaveCount(1);
      await page.locator('.doc-edit-note').last().scrollIntoViewIfNeeded();
      await shot('4-agent-edit');
      await page.goto(`${new URL(page.url()).pathname}?thread=${thread.id}`);
      await expect(page.locator('.thread-panel .edit-result')).toContainText('Edited rollout.md · version 3');
      await expect(page.locator('.thread-panel .quote-anchor')).toContainText('Version 3 changed this passage');
      await page.waitForTimeout(200); // the panel's reveal
      await shot('5-thread');
      await page.goto(new URL(page.url()).pathname);
      await page.locator('.msg.doc [data-block]').first().waitFor();

      // 3. A save that meets a newer version: the draft stays, the conflict says who saved what.
      await head.getByRole('button', { name: 'Edit the document' }).click();
      await area.fill((await area.inputValue()).replace('three stages', 'three careful stages'));
      await page.request.patch(`/api/documents/${doc.id}`, { data: { base: 3, ops: [{ find: 'under 150 ms', replace: 'under 120 ms' }] } });
      await expect(head.locator('.doc-history-btn')).toContainText('v4');
      await area.press('ControlOrMeta+Enter');
      await expect(page.locator('.doc-conflict')).toContainText('You saved version 4 while you were editing.');
      await expect(area).toHaveValue(/three careful stages/);
      await page.locator('.doc-conflict').scrollIntoViewIfNeeded();
      await shot('6-conflict');
      await page.getByRole('button', { name: 'Discard mine' }).click();

      // 4. Versions: look at the first one, and restore it.
      await head.getByRole('button', { name: 'Versions of this document' }).click();
      await expect(page.locator('.doc-version-item')).toHaveCount(4);
      await shot('7-versions');
      await page.locator('.doc-version-item').last().click();
      await expect(page.locator('.doc-preview-bar')).toContainText('Version 1 of 4');
      await expect(page.locator('.md-doc')).toContainText('covered by the runbook');
      await shot('8-preview');
      await page.getByRole('button', { name: 'Restore this version' }).click();
      await expect(page.locator('.doc-preview-bar')).toHaveCount(0);
      await expect(head.locator('.doc-history-btn')).toContainText('v5');
      await expect(page.locator('.md-doc')).toContainText('behind a flag.');
      // The thread's paragraph is back as it was quoted: no longer marked.
      await expect(page.locator('.thread-badge-changed')).toHaveCount(0);
    });
  }
