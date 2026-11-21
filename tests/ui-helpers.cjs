async function openTeamSettings(page) {
  await page.locator('[data-action="open-drawer"]').click();
  if (!await page.locator('.drawer-options').evaluate(d => d.open)) {
    await page.locator('.drawer-options > summary').click();
  }
  await page.locator('.drawer-options [data-action="new-team"]').click();
}

module.exports = { openTeamSettings };
