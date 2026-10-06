import { test, expect } from '@playwright/test';
const signIn=async(page,role='student')=>{await page.goto('/');await page.getByRole('button',{name:role==='admin'?'Admin':role==='editor'?'Editor':'Student',exact:true}).click();await expect(page.getByRole('heading',{name:/Good (morning|afternoon|evening)/})).toBeVisible();};
const go=async(page,name,mobile=false)=>{await page.locator(mobile?'.mobile-nav':'.main-nav').getByRole('button',{name:new RegExp('^'+name)}).click();};

test('student dashboard, agenda, calendar, exams, personal notifications and safe unknowns',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await signIn(page);
  await expect(page.getByText('DEMO CLASS',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Create event',exact:true})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Today’s schedule'})).toBeVisible();
  await page.screenshot({path:'test-results/desktop-home.png',fullPage:true});
  await go(page,'Schedule');
  await expect(page.getByRole('heading',{name:'Your schedule'})).toBeVisible();
  const cancelled=page.locator('.event-card').filter({hasText:'Histology seminar'});
  await expect(cancelled.getByText('Cancelled',{exact:true})).toBeVisible();
  const unconfirmed=page.locator('.event-card').filter({hasText:'Pharmacology foundations'});
  await expect(unconfirmed.getByText('Unknown',{exact:true})).toBeVisible();
  await expect(unconfirmed.getByText('Location to be confirmed',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Calendar',exact:true}).click();
  await expect(page.locator('.calendar-grid')).toBeVisible();
  await page.getByRole('button',{name:'Next month',exact:true}).click();
  await page.getByRole('button',{name:'Today',exact:true}).click();
  await page.getByRole('button',{name:'Agenda',exact:true}).click();
  await page.getByLabel('Search events').fill('Pharmacology');
  await expect(page.locator('.event-card')).toHaveCount(1);
  await page.getByLabel('Search events').fill('');
  await go(page,'Exams');
  await expect(page.getByRole('heading',{name:'Upcoming exams',exact:true})).toBeVisible();
  const exam=page.locator('.exam-card').filter({hasText:'Biochemistry final'});
  await expect(exam.getByText('Time to be confirmed',{exact:false})).toBeVisible();
  await expect(exam.getByText('Unknown',{exact:true})).toBeVisible();
  await go(page,'Updates');
  await page.getByRole('button',{name:'Mark all as read',exact:true}).click();
  await expect(page.locator('.update-card.unread')).toHaveCount(0);
  await page.reload();await go(page,'Updates');
  await expect(page.locator('.update-card.unread')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('admin previews and creates, connected student receives edits, history restores and reload persists',async({browser})=>{
  const adminContext=await browser.newContext(),studentContext=await browser.newContext();
  const admin=await adminContext.newPage(),student=await studentContext.newPage();
  const errors=[];admin.on('pageerror',e=>errors.push(e.message));student.on('pageerror',e=>errors.push(e.message));
  try{
    await signIn(admin,'admin');await signIn(student);await go(student,'Schedule');
    await admin.getByRole('button',{name:'Create event',exact:true}).click();
    const dialog=admin.getByRole('dialog');
    await dialog.getByLabel('Event title',{exact:true}).fill('Browser verified cardiology');
    await dialog.getByLabel('Subject',{exact:true}).fill('Cardiology');
    await dialog.getByLabel('Room (optional)',{exact:true}).fill('A12');
    await dialog.getByRole('button',{name:'Preview',exact:true}).click();
    await expect(dialog.getByRole('heading',{name:'Review before publishing'})).toBeVisible();
    await dialog.getByRole('button',{name:'Publish event',exact:true}).click();
    await expect(dialog).not.toBeVisible();
    const studentCard=student.locator('.event-card').filter({hasText:'Browser verified cardiology'});
    await expect(studentCard).toBeVisible();await expect(studentCard.getByText('A12',{exact:true})).toBeVisible();
    const adminCard=admin.locator('.event-card').filter({hasText:'Browser verified cardiology'});
    await adminCard.getByRole('button',{name:'Quick edit',exact:true}).click();
    await dialog.getByLabel('Room (optional)',{exact:true}).fill('B04');
    await dialog.getByLabel('Attendance',{exact:true}).selectOption('required');
    await dialog.getByRole('button',{name:'Preview',exact:true}).click();
    await expect(dialog.getByText('A12',{exact:true})).toBeVisible();
    await expect(dialog.getByText('B04',{exact:true})).toBeVisible();
    await dialog.getByRole('button',{name:'Publish changes',exact:true}).click();
    await expect(studentCard.getByText('B04',{exact:true})).toBeVisible();
    await expect(studentCard.getByText('Required',{exact:true})).toBeVisible();
    await student.reload();await go(student,'Schedule');await expect(studentCard.getByText('B04',{exact:true})).toBeVisible();
    await adminCard.getByRole('button',{name:'Browser verified cardiology',exact:true}).click();
    await dialog.getByRole('button',{name:'Version history',exact:true}).click();
    await expect(dialog.getByText('Room changed from A12 to B04',{exact:true})).toBeVisible();
    await dialog.getByRole('button',{name:'Review restoration',exact:true}).click();
    await dialog.getByRole('button',{name:'Restore & publish',exact:true}).click();
    await expect(studentCard.getByText('A12',{exact:true})).toBeVisible();
    await expect(studentCard.getByText('Unknown',{exact:true})).toBeVisible();
    expect(errors).toEqual([]);
  }finally{await adminContext.close();await studentContext.close();}
});

test('mobile student navigation fits viewport; admin can edit and publish an announcement',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const fits=async()=>expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  try{
    await signIn(page);await fits();await page.screenshot({path:'test-results/mobile-home.png',fullPage:true});
    expect(await page.evaluate(()=>window.scrollY)).toBe(0);
    for(const name of ['Schedule','Exams','Updates','Home']){await go(page,name,true);await fits();}
    await go(page,'Schedule',true);await page.getByRole('button',{name:'Calendar',exact:true}).click();await fits();
    await page.screenshot({path:'test-results/mobile-calendar.png',fullPage:true});
    await page.getByRole('button',{name:'Account and class settings',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'Sign out',exact:true}).click();
    await signIn(page,'admin');await go(page,'Updates',true);
    await page.getByRole('button',{name:'Post announcement',exact:true}).click();
    const dialog=page.getByRole('dialog');await dialog.getByLabel('Title',{exact:true}).fill('Mobile announcement');await dialog.getByLabel('Message',{exact:true}).fill('Bring your student ID tomorrow.');await dialog.getByLabel('Priority',{exact:true}).selectOption('urgent');await dialog.getByLabel('Pin this announcement').check();
    await fits();await dialog.getByRole('button',{name:'Preview',exact:true}).click();await dialog.getByRole('button',{name:'Publish announcement',exact:true}).click();
    await expect(dialog).not.toBeVisible();await expect(page.getByRole('heading',{name:'Mobile announcement',exact:true})).toBeVisible();
    await go(page,'Home',true);await expect(page.getByRole('heading',{name:'Mobile announcement',exact:true})).toBeVisible();await fits();
    await page.getByRole('button',{name:'Create event',exact:true}).click();await fits();await page.getByRole('dialog').getByRole('button',{name:'Close dialog',exact:true}).click();
    await go(page,'Admin',true);await expect(page.getByRole('heading',{name:'Manage your class',exact:true})).toBeVisible();await fits();
    expect(errors).toEqual([]);
  }finally{await context.close();}
});

test('admin invitation link creates a new student account through the UI',async({browser})=>{
  const a=await browser.newContext(),b=await browser.newContext();const admin=await a.newPage(),student=await b.newPage();
  try{
    await signIn(admin,'admin');await go(admin,'Manage class');
    await admin.locator('#invite-form').getByRole('button',{name:'Create invitation',exact:true}).click();
    const link=await admin.getByLabel('Student invitation link',{exact:true}).inputValue();
    await student.goto(link);
    await expect(student.getByRole('heading',{name:'Join your class',exact:true})).toBeVisible();
    await student.getByLabel('Your name',{exact:true}).fill('New invited student');await student.getByLabel('Email address',{exact:true}).fill('browser-invited@university.edu');await student.getByLabel('Password',{exact:true}).fill('BrowserInvited2026!');
    await student.getByRole('button',{name:'Create account & join',exact:true}).click();
    await expect(student.getByRole('heading',{name:/Good (morning|afternoon|evening), New/})).toBeVisible();
    await expect(student.getByRole('button',{name:'Create event',exact:true})).toHaveCount(0);
    await expect(student.locator('.class-sub')).toContainText('Student');
  }finally{await a.close();await b.close();}
});
