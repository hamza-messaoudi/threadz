// Ad-hoc full-page screenshot of the style lab: node test/visual/lab-shot.mjs <out.png> [fixture] [light|dark] [message|thread|demo]
import { chromium } from '@playwright/test';
const [out, fixture = 'prose', scheme = 'light', width = 'message'] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
await p.goto(`http://127.0.0.1:4799/dev/markdown?fixture=${fixture}&width=${width}&t=${'a'.repeat(48)}`);
await p.locator('[data-testid=lab-canvas] .md-body').waitFor();
await p.waitForTimeout(2500);
await p.addStyleTag({ content: '.app{height:auto!important} .style-lab{height:auto!important;overflow:visible!important} html,body,#root,.main{height:auto!important}' });
await p.waitForTimeout(300);
await p.screenshot({ path: out, fullPage: true });
await b.close();
