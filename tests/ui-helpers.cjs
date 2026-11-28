async function openDrawerOption(page, selector) {
  await page.locator('[data-action="open-drawer"]').click();
  if (!await page.locator('.drawer-options').evaluate(d => d.open)) {
    await page.locator('.drawer-options > summary').click();
  }
  await page.locator('.drawer-options').locator(selector).click();
}

async function openTeamSettings(page) {
  await openDrawerOption(page, '[data-action="new-team"]');
}

async function openSavedChat(page, title) {
  await page.locator('[data-action="open-drawer"]').click();
  await page.locator('#chatList [data-action="open-chat"]').filter({ hasText: title }).click();
}

module.exports = { openTeamSettings, openDrawerOption, openSavedChat };
