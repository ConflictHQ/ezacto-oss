import { expect,test } from '@playwright/test'
test('owns, rotates and revokes a minimized advisory calendar subscription from Capacity',async({page},info)=>{
  await page.route('https://fonts.googleapis.com/**',route=>route.abort())
  await page.request.post('/__ezacto_browser_fixture__/start-end',{data:{action:'sign-in-rate-reset'},headers:{'x-ezacto-browser-fixture-control':'start-end-round-trip'}})
  await page.goto('/capacity')
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
  await page.getByLabel('Password',{exact:true}).fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
  await page.getByRole('button',{name:'Sign in',exact:true}).click()
  const panel=page.locator('[data-calendar-feeds]')
  await panel.locator('summary').click()
  await expect(panel.getByRole('button',{name:'Create subscription',exact:true})).toBeEnabled()
  await expect(panel.getByLabel('Scope',{exact:true})).toHaveValue('self')
  await expect(panel.getByLabel('Include permitted person and role names')).not.toBeChecked()
  const created=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/calendar-feeds'&&r.request().method()==='POST')
  await panel.getByRole('button',{name:'Create subscription',exact:true}).click()
  const response=await created
  expect(response.status()).toBe(201)
  const result=(await response.json()).data
  expect(result.feed.scope).toBe('self');expect(result.feed.include_names).toBe(false)
  const basic=(password:string)=>`Basic ${Buffer.from(`${result.username}:${password}`).toString('base64')}`
  const url=await panel.locator('[data-calendar-feed-secret] input').first().inputValue()
  expect(new URL(url).pathname).toBe('/calendar/planning.ics');expect(new URL(url).search).toBe('')
  let currentPassword=result.password
  try{
    const first=await page.request.get(url,{headers:{authorization:basic(currentPassword)}})
    expect(first.status()).toBe(200);expect(first.headers()['cache-control']).toBe('private, no-store')
    const original=await first.text();expect(original).toContain('BEGIN:VCALENDAR')
    const row=panel.locator(`[data-calendar-feed-id="${result.feed.id}"]`)
    const downloaded=page.waitForEvent('download')
    await row.getByRole('button',{name:'Download calendar',exact:true}).click()
    expect((await downloaded).suggestedFilename()).toBe('ezacto-planning.ics')
    const rotated=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/calendar-feeds/${result.feed.id}/rotate`)
    await row.getByRole('button',{name:'Rotate password',exact:true}).click()
    const renewal=(await(await rotated).json()).data
    const denied=await page.request.get(url,{headers:{authorization:basic(currentPassword)}})
    expect(denied.status()).toBe(404);expect(await denied.text()).toBe('')
    currentPassword=renewal.password
    const renewed=await page.request.get(url,{headers:{authorization:basic(currentPassword)}})
    expect(renewed.status()).toBe(200);expect(await renewed.text()).toBe(original)
    await row.getByRole('button',{name:'Revoke subscription',exact:true}).click()
    await expect(row).toContainText('Revoked')
    await expect(panel.locator('[data-calendar-feed-secret]')).toBeHidden()
    const revoked=await page.request.get(url,{headers:{authorization:basic(currentPassword)}})
    expect(revoked.status()).toBe(404);expect(await revoked.text()).toBe('')
    await page.screenshot({path:info.outputPath('calendar-subscription-phone.png'),fullPage:true})
  }finally{
    await page.evaluate(async id=>{await fetch(`/api/v1/calendar-feeds/${id}`,{method:'DELETE',credentials:'same-origin'})},result.feed.id)
  }
})
