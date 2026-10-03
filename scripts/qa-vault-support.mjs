// Only for isolated QA browser profiles. Exercises the actual gate; no production bypass.
export const QA_VAULT_PHRASE='fictional pace qa vault phrase';
export async function ensureVaultGate(page) {
  await page.waitForFunction(()=>document.querySelector('.vault-screen input[name="passphrase"], .onboarding, .bottom-nav, .lock-screen, .fatal-error'),{},{timeout:30000});
  const input=page.locator('.vault-screen input[name="passphrase"]');
  if(!await input.isVisible())return;
  await input.fill(QA_VAULT_PHRASE);
  const confirm=page.locator('.vault-screen input[name="confirmation"]');
  if(await confirm.isVisible())await confirm.fill(QA_VAULT_PHRASE);
  await page.locator('.vault-screen button[type="submit"]').click();
  await page.locator('.vault-screen').waitFor({state:'hidden',timeout:30000});
}
export function installVaultSupport(page) {
  const goto=page.goto.bind(page),reload=page.reload.bind(page);
  page.goto=async(...args)=>{const result=await goto(...args);await ensureVaultGate(page);return result;};
  page.reload=async(...args)=>{const result=await reload(...args);await ensureVaultGate(page);return result;};
}
