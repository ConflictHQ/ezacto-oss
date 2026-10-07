import { renderStaffPayments } from '../staff-payments/render.js'
import { shellJavascript, shellStylesheet } from '../generated/shell-assets.js'
import { iconMarkup, type IconName } from '../components/icons.js'
import { INSTANCE_THEME_STYLESHEET_PATH } from '../instance-theme.js'
import { defaultTheme, themeManifest } from '../theme.js'
import { type ColorScheme, colorSchemeMeta, resolveColorScheme } from '../theme-preference.js'
import {
  type NavLayout,
  resolveNavLayout,
  resolveSidebarState,
  type SidebarState,
} from '../nav-layout.js'
import { type DeploymentBrand, defaultBrand, resolveDeploymentBrand } from '../brand.js'
import { renderClientDirectoryPages } from '../clients/render.js'
import { renderRoleAdminPage } from '../roles/render.js'
import { renderProjectDirectoryPages } from '../projects/render.js'
import { renderDashboardPage } from '../dashboard/render.js'
import { renderReportsPage } from '../reports/render.js'
import { renderExpenseWorkflowPages } from '../expenses/render.js'
import { renderTaskAdminPage } from '../tasks/render.js'
import { renderTeamPages } from '../team/render.js'
import { renderExpenseCategoriesPage } from '../expense-categories/render.js'
import { renderEmailConfigPage } from '../email-config/render.js'
import { renderRecurringEditorPage, renderRecurringPage } from '../recurring/render.js'
import { renderEstimatesPage } from '../estimates/render.js'
import { renderRetainerDialogs, renderRetainerPage } from '../retainers/render.js'
import {
  renderActivityLogPage,
  renderDeliveriesPage,
  renderModuleSettingsPage,
} from '../module-settings/render.js'
import {
  renderInvoiceAttachmentSection,
  renderInvoiceComposerDialog,
  renderInvoiceEditPage,
  renderInvoicePaymentDialogs,
  renderInvoicePaymentSection,
  renderInvoiceLineEditor,
  renderInvoiceOverflowMenu,
  renderInvoiceTransitionDialog,
} from '../invoices/render.js'

export interface ShellTab {
  readonly label: string
  readonly href: string
  readonly current?: boolean
}

export interface AppShellOptions {
  readonly environment: string
  readonly release: string
  readonly brand?: Partial<DeploymentBrand>
  /**
   * Whether this instance has a palette of its own (issue 591). Only a flag: the
   * colours themselves are served as a stylesheet, because the shell's
   * `style-src` admits no inline style, and linking a stylesheet that would be
   * empty costs every page load a request for nothing.
   */
  readonly instanceTheme?: boolean
  /**
   * The person's light/dark choice, read from their cookie by the server so the
   * page is painted in it from the first byte (`readDisplayPreferences`).
   * Absent means `system`, which the stylesheet resolves without a script.
   */
  readonly colorScheme?: ColorScheme
  /**
   * Sidebar or top bar, and whether the sidebar is narrowed to its icons --
   * read from the person's cookies like `colorScheme`, so the page is laid out
   * once, in the layout they chose. Absent means a full-width sidebar.
   */
  readonly navLayout?: NavLayout
  readonly sidebar?: SidebarState
  readonly activeSection?:
    // 'Settings' matches no nav item on purpose. Without it the default lands
    // on 'Time', so the module settings page marked Time as the page you were
    // on; naming a section outside the primary nav marks nothing, which is the
    // truth.
    | 'Settings'
    | 'Home'
    | 'Time'
    | 'Approvals'
    | 'Expenses'
    | 'Team'
    | 'Projects'
    | 'Tasks'
    | 'Clients'
    | 'Invoices'
    | 'Reports'
    | 'Payments'
  readonly view?:
    | 'dashboard'
    | 'time'
    | 'timesheet-approvals'
    | 'invoice-list'
    | 'invoice-detail'
    | 'invoice-edit'
    | 'invoice-generation'
    | 'invoice-recurring'
    | 'invoice-recurring-editor'
    | 'invoice-estimates'
    | 'invoice-retainers'
    | 'client-list'
    | 'client-detail'
    | 'project-list'
    | 'project-detail'
    | 'task-list'
    | 'reports'
    | 'staff-payments'
    | 'expense-list'
    | 'expense-detail'
    | 'expense-categories'
    | 'settings-user'
    | 'settings-company'
    | 'settings-activity'
    | 'settings-deliveries'
    | 'settings-templates'
    | 'settings-roles'
    | 'team-list'
    | 'team-person'
    | 'not-found'
  /**
   * The level-2 strip under the header. Time supplies its own Week/Day pair
   * when this is absent, which is what every page rendered before the strip was
   * a parameter of anything: one section owned the only sub-navigation in the
   * shell and no other could have any.
   */
  readonly tabs?: readonly ShellTab[]
  readonly signInProviders?: readonly SignInProvider[]
  /**
   * Whether the email-and-password form is offered (issue 761). Default true,
   * because that is how every deployment behaved before the setting existed.
   * The routes refuse independently; this only stops the page offering a way in
   * that would be turned away.
   */
  readonly passwordSignIn?: boolean
  /**
   * Sign-in credentials printed on the page. Only a demo deployment ever
   * supplies them, and only a deployment whose database is rebuilt nightly has
   * any business doing so.
   */
  readonly demoAccounts?: readonly DemoSignInAccount[]
  /**
   * Whether this page is the public demo (issue 931). Marked on `<html>` so a
   * control the demo refuses can say so before it is clicked rather than
   * after. Presentation only: the Worker refuses those requests either way.
   */
  readonly demo?: boolean
  /**
   * Whether this deployment holds its mail to an allowlist, so the Send dialog
   * can say so. A flag and never the list: a page that named the approved
   * domains would tell every visitor where the demo can send.
   */
  readonly demoMailRestricted?: boolean
  /** Presentation hint only. The browser still validates the session before enabling the app. */
  readonly sessionCookiePresent?: boolean
}

export type SignInProvider = 'google' | 'github'

export interface DemoSignInAccount {
  /** What the account is, e.g. "Administrator". */
  readonly label: string
  readonly email: string
  readonly password: string
  /** One line on what this account can see, so the choice between them means something. */
  readonly describes: string
}

export interface DataQualityBannerOptions {
  readonly message: string
  readonly fixHref: string
  readonly fixLabel: string
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  )

const safePath = (value: string): string => {
  if (!value.startsWith('/') || value.startsWith('//')) {
    throw new Error('deep links must be same-origin absolute paths')
  }
  return value
}

export const renderDataQualityBanner = (options: DataQualityBannerOptions): string =>
  `<aside class="data-quality" role="status" data-data-quality-banner>` +
  `<span>${escapeHtml(options.message)}</span>` +
  `<a href="${escapeHtml(safePath(options.fixHref))}">${escapeHtml(options.fixLabel)}</a>` +
  `</aside>`

/**
 * Time's own strip is the fallback, not the definition. Its links are marked
 * data-time-views because the browser rewrites aria-current on them from the
 * ?view= parameter -- a rule that is right for Time and wrong for every other
 * section, which does not navigate by that parameter and would have its current
 * tab stripped on load.
 *
 * It also carries view-switch, because Week and Day are two ways of looking at
 * one screen rather than two sections of the app; the level-2 underline now
 * says "you are in this part of ezacto" for Invoices and Reports, and a signal
 * that means two things means neither.
 */
const renderTabStrip = (options: AppShellOptions): string => {
  const view = options.view ?? 'time'
  if (options.tabs === undefined) {
    return (
      `<nav class="tabstrip view-switch" aria-label="Time views" data-time-views${view === 'time' ? '' : ' hidden'}>` +
      `<a href="/" aria-current="page">Week</a><a href="/?view=day">Day</a>` +
      // Restored now that it leads somewhere. It was deleted in issue 296's first
      // stage precisely because a tab that does nothing is worse than a missing
      // feature, and putting it back without the panel would repeat that.
      `<a href="/?view=calendar">Calendar</a>` +
      `</nav>`
    )
  }
  if (options.tabs.length === 0) return ''
  const links = options.tabs
    .map(
      (tab) =>
        `<a href="${escapeHtml(safePath(tab.href))}"${tab.current === true ? ' aria-current="page"' : ''}>` +
        `${escapeHtml(tab.label)}</a>`,
    )
    .join('')
  return `<nav class="tabstrip" aria-label="${escapeHtml(options.activeSection ?? 'Section')} views">${links}</nav>`
}

/**
 * Invoices' four destinations. Four routes render the same strip, and a strip
 * assembled separately at each of them is a strip whose tabs disagree about
 * where they point; the only thing a route chooses is which one it is on.
 */
const invoiceDestinations = [
  ['Overview', '/invoices', 'invoice-list'],
  ['Recurring', '/invoices/recurring', 'invoice-recurring'],
  // Issue 485: seven API paths served since the API shipped with no screen
  // calling any of them. Beside Recurring because an estimate is the document
  // an invoice comes from, not a setting.
  ['Estimates', '/invoices/estimates', 'invoice-estimates'],
  ['Retainers', '/invoices/retainers', 'invoice-retainers'],
  // Configure left this strip for Settings. Two of the five templates it edits
  // -- the email-verification and password-reset messages -- are account mail
  // with nothing to do with invoicing, and it sits beside sender identity and
  // DNS, which is company-wide setup (issue 546). /invoices/configure still
  // resolves; it redirects.
] as const

export const invoiceTabs = (view: AppShellOptions['view']): readonly ShellTab[] =>
  invoiceDestinations.map(([label, href, destination]) => ({
    label,
    href,
    ...(view === destination ? { current: true } : {}),
  }))

/**
 * The mark, or the name set in it. Which of the two configured wordmarks a
 * surface asks for is decided by the ground it paints, not by the surface:
 * the topbar and the sign-in splash are `--ez-band` and take the dark-ground
 * mark, the document shell is `--ez-ground` and takes the light-ground one.
 *
 * The name stays the alt text rather than being dropped, so a mark that fails
 * to load, or a reader who is not looking at the screen, still gets the brand
 * the deployment set instead of an empty link.
 */
/**
 * Same-origin, and therefore loadable. Every shell response sets
 * `img-src 'self' data:`, so only a mark this deployment serves itself can be an
 * `<img>` at all -- an uploaded asset, which lives at a root-relative
 * `/brand/<slot>/<hash>`.
 *
 * `//host/path` is excluded deliberately: it reads as a path and is a
 * cross-origin URL, which is exactly the case a `startsWith('/')` alone gets
 * wrong.
 */
const sameOriginMark = (source: string): boolean =>
  source.startsWith('/') && !source.startsWith('//')

/**
 * `BRAND_WORDMARK_*` take URLs to files the operator hosts elsewhere, and the
 * CSP above refuses those outright. Rendering one as an `<img>` regardless
 * would replace a styled wordmark with whatever the browser does for a blocked
 * image -- on the sign-in splash, which is the first thing anyone sees.
 *
 * So the two sources are not interchangeable and are not treated as one: an
 * uploaded mark is served from here and renders; a configured URL keeps the
 * text wordmark it has always rendered. `team/browser.ts` reached the same
 * conclusion about avatars for the same reason, and keeps its text underneath.
 */
// The product's own mark, drawn only for the default brand: an operator who
// renames the deployment without uploading a mark gets their name, not ours.
const productLogo =
  '<svg class="brand-logo" viewBox="0 0 60 60" aria-hidden="true" focusable="false">' +
  '<path fill-rule="evenodd" clip-rule="evenodd" d="M20 0H40C53.3 0 60 6.7 60 20V40C60 53.3 53.3 60 40 60H20C6.7 60 0 53.3 0 40V20C0 6.7 6.7 0 20 0ZM13 25C14.3 23.7 15.7 23.7 17 25L26 34L43 14C44.3 12.7 46 12.7 48 14C50 15.3 50 17 48 19L30 41C28 43.7 26 44 24 42L12 31C10 29 10.3 27 13 25ZM27.5 8C27.5 6.3 28.3 5.5 30 5.5C31.7 5.5 32.5 6.3 32.5 8V12C32.5 13.7 31.7 14.5 30 14.5C28.3 14.5 27.5 13.7 27.5 12V8Z"/>' +
  '</svg>'

const wordmark = (source: string | undefined, brand: string): string =>
  source === undefined || source === '' || !sameOriginMark(source)
    ? brand === defaultBrand.name
      ? `<span class="brand-lockup">${productLogo}<span class="brand-name">${escapeHtml(brand)}</span></span>`
      : escapeHtml(brand)
    : `<img class="brand-mark" src="${escapeHtml(source)}" alt="${escapeHtml(brand)}">`

export const renderEmptyState = (title: string, detail: string): string =>
  `<section class="empty-state" data-empty-state>` +
  `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p></section>`

export const renderDocumentShell = (title: string, content: string, brand?: Partial<DeploymentBrand>): string => {
  const b = resolveDeploymentBrand(brand)
  return `<article class="document-shell" data-document-shell data-ez-theme="${defaultTheme}">` +
  `<header><a href="/">← Time</a><span>${wordmark(b.wordmarkLight, b.name)}</span></header>` +
  `<main><h1>${escapeHtml(title)}</h1><div class="document-content">${escapeHtml(content)}</div>` +
  `</main></article>`
}

/**
 * The primary strip (issue 461).
 *
 * Six, per the analysis in §6: Time, Expenses, Projects, Clients, Invoices,
 * Reports. Ten top-level sections was the junk-drawer failure §6 diagnoses in
 * legacy `Manage`, arrived at from the other direction -- everything promoted
 * rather than everything buried -- and it spends the density budget the same
 * section asks for.
 *
 * Three left, and each for its own reason:
 *
 * `Tasks` and `Team` are configuration in every reference, and §6 names Tasks
 * explicitly. Their routes and command-palette entries are untouched; only the
 * strip stops carrying them.
 *
 * `Home` moves to the wordmark, which is where a masthead normally goes home.
 *
 * `Approvals` stays and is not a seventh for most people: it is already gated,
 * so it appears only for a profile that approves timesheets. Folding a
 * role-gated daily surface into Settings to reach a count derived from an
 * account that had no such surface would follow §6's letter against its
 * reasoning.
 */
const sections = [
  'Time',
  'Approvals',
  'Expenses',
  'Projects',
  'Clients',
  'Invoices',
  'Payments',
  'Reports',
] as const

/**
 * The sections that browse the firm's directories rather than the reader's own
 * work. They share one attribute because they answer one question -- may this
 * profile browse them -- and the browser opens all three from the same
 * capability, the way Approvals, Team and Invoices are each opened from theirs.
 */
const directorySections: ReadonlySet<string> = new Set(['Projects', 'Tasks', 'Clients'])

/**
 * Folded out of the strip by issue 461, and still reachable.
 *
 * `Tasks` and `Team` are configuration, which is where §6 puts them; `Home`
 * moves to the wordmark. None of the three loses its route, and all three keep
 * the permission gate they had -- which matters for more than tidiness: the
 * command palette decides what to offer by reading whether the nav element for
 * a destination is present and showing. Drop the element and `paletteOffers`
 * fails closed, so folding these without rehoming them would have quietly taken
 * them out of the palette too, leaving a URL as the only way back.
 */
const foldedSections = ['Home', 'Tasks', 'Team'] as const

/**
 * Each section's mark (the 2026-10 reskin). A collapsed sidebar is read by
 * these alone, so every section has one; the label stays in the link, hidden
 * from sight but not from a screen reader, so the link's name never changes.
 */
const sectionIcons: Readonly<
  Record<(typeof sections)[number] | (typeof foldedSections)[number], IconName>
> = {
  Time: 'clock',
  Approvals: 'check',
  Expenses: 'card',
  Projects: 'folder',
  Clients: 'person',
  Invoices: 'document',
  Payments: 'banknote',
  Reports: 'chart',
  Home: 'home',
  Tasks: 'list',
  Team: 'people',
}

const hrefFor = (section: (typeof sections)[number] | (typeof foldedSections)[number]): string =>
  section === 'Home'
    ? '/dashboard'
    : section === 'Time'
      ? '/'
      : section === 'Approvals'
        ? '/approvals'
        : section === 'Invoices'
          ? '/invoices'
          : `/${section.toLocaleLowerCase('en-US')}`

const providerSignIn = (
  providers: readonly SignInProvider[],
  passwordSignIn: boolean,
): string => {
  const links: string[] = []
  if (providers.includes('google')) {
    links.push(
      `<a class="oidc-sign-in" data-oidc-provider="google" href="${safePath('/auth/oidc/google')}">Continue with Google</a>`,
    )
  }
  if (providers.includes('github')) {
    links.push(
      `<a class="oidc-sign-in" data-oidc-provider="github" href="${safePath('/auth/github')}">Continue with GitHub</a>`,
    )
  }
  if (links.length === 0) return ''
  return (
    `<div class="oidc-entry" data-oidc-entry>` +
    links.join('') +
    // The divider introduces the password form. With no form under it, it
    // would announce a choice the page is not offering.
    (passwordSignIn
      ? `<span class="auth-divider" aria-hidden="true">or use your password</span>`
      : '') +
    `</div>`
  )
}

/**
 * What the card says when the operator has switched every way in off and the
 * deployment configured none. Better than a blank card: somebody has to be
 * told to go and fix the setting, and the sign-in page is where they are.
 */
const noSignInMethod = (brand: string): string =>
  renderEmptyState(
    'Sign-in is unavailable',
    `No sign-in method is switched on for this ${escapeHtml(brand)} instance. An administrator has to enable one before anybody can sign in.`,
  )

/**
 * The credentials panel a demo deployment publishes on its own front page.
 *
 * Two accounts rather than one, because the interesting thing about a demo is
 * what each profile is allowed to see, and a single administrator login hides
 * exactly that. The fill button is not a convenience: a nineteen-character
 * password typed by hand is where a person gives up on a demo.
 */
const demoCredentials = (accounts: readonly DemoSignInAccount[]): string => {
  if (accounts.length === 0) return ''
  const rows = accounts
    .map(
      (account) =>
        `<li>` +
        `<p class="demo-account-label">${escapeHtml(account.label)}</p>` +
        `<p class="demo-account-describes">${escapeHtml(account.describes)}</p>` +
        `<p class="demo-account-secret"><code>${escapeHtml(account.email)}</code>` +
        `<code>${escapeHtml(account.password)}</code></p>` +
        `<button type="button" class="demo-account-fill" data-demo-fill` +
        ` data-demo-email="${escapeHtml(account.email)}"` +
        ` data-demo-password="${escapeHtml(account.password)}">` +
        `Fill in ${escapeHtml(account.label.toLowerCase())}</button>` +
        `</li>`,
    )
    .join('')
  return (
    `<section class="demo-credentials" data-demo-credentials aria-label="Demo accounts">` +
    `<p class="eyebrow">Demo instance</p>` +
    `<p class="demo-credentials-note">Every client, project and hour here is invented, ` +
    `and the database is wiped and rebuilt each night. Sign in with either account.</p>` +
    `<ul>${rows}</ul>` +
    `</section>`
  )
}

/**
 * What an unrouted path renders (issue 557).
 *
 * A stale bookmark or a mistyped URL used to drop the reader onto the API's
 * JSON error object filling the viewport, with no way back. This is the same
 * shell every other page gets, so the header and navigation are already there;
 * the body only has to say what happened and offer the way out.
 */
const renderNotFoundPage = (view?: string): string => `
  <main class="app-content page--grid" data-not-found-page${view === 'not-found' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Not found</p><h1>That page does not exist</h1></div>
    </header>
    <p class="not-found-intro">The address may be mistyped, or the page may have moved since it was bookmarked.</p>
    <p><a href="/">Go to Time</a></p>
  </main>`

export const renderAppShell = (options: AppShellOptions): string => {
  const active = options.activeSection ?? 'Time'
  const view = options.view ?? 'time'
  const b = resolveDeploymentBrand(options.brand)
  const brand = b.name
  const passwordSignIn = options.passwordSignIn ?? true
  const resumeSession = options.sessionCookiePresent === true
  const shortRelease = options.release.slice(0, 7)
  // Resolved again rather than trusted: it lands in an attribute, and the type
  // is a promise the caller made, not one the value kept.
  const colorScheme = resolveColorScheme(options.colorScheme)
  const instancePalette = options.instanceTheme === true
  const navLayout = resolveNavLayout(options.navLayout)
  const sidebar = resolveSidebarState(options.sidebar)
  const navLink = (section: (typeof sections)[number] | (typeof foldedSections)[number]): string =>
    `<a href="${hrefFor(section)}"${section === 'Approvals' ? ' data-approvals-nav hidden' : ''}${section === 'Team' ? ' data-team-nav hidden' : ''}${section === 'Payments' ? ' data-staff-payments-nav hidden' : ''}${section === 'Expenses' ? ' data-expenses-nav' : ''}${section === 'Invoices' ? ' data-money-nav hidden' : ''}${directorySections.has(section) ? ' data-directory-nav hidden' : ''}${section === active ? ' aria-current="page"' : ''}>${iconMarkup(sectionIcons[section])}<span class="nav-label">${section}</span></a>`
  const navigation = sections.map(navLink).join('')
  const foldedNavigation = foldedSections.map(navLink).join('')

  return `<!doctype html>
<html lang="en" data-ez-theme="${defaultTheme}" data-ez-scheme="${colorScheme}"${instancePalette ? ' data-ez-palette="instance"' : ''} data-ez-nav="${navLayout}" data-ez-sidebar="${sidebar}" data-app-view="${view}" data-auth-state="${resumeSession ? 'checking' : 'unknown'}" data-brand="${escapeHtml(brand)}"${options.demo === true ? ' data-demo-deployment' : ''}${options.demoMailRestricted === true ? ' data-demo-mail-restricted' : ''}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="${colorSchemeMeta(colorScheme, instancePalette)}">
  <meta name="robots" content="noindex">
  <meta name="ezacto-environment" content="${escapeHtml(options.environment)}">
  <meta name="ezacto-release" content="${escapeHtml(options.release)}">
  <title>${escapeHtml(brand)} — Sign in</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="${escapeHtml(themeManifest.precision.fontStylesheet)}">
${b.favicon ? `  <link rel="icon" href="${escapeHtml(b.favicon)}">\n` : ''}  <link rel="stylesheet" href="/assets/ezacto.css">
${instancePalette ? `  <link rel="stylesheet" href="${INSTANCE_THEME_STYLESHEET_PATH}">\n` : ''}  <script type="module" src="/assets/ezacto.js"></script>
</head>
<body>
  <section class="auth-gateway" data-auth-gateway data-state="checking" aria-label="${escapeHtml(brand)} sign in" aria-busy="true"${resumeSession ? ' hidden' : ''}>
    <div class="auth-splash">
      <a class="auth-wordmark" href="/" aria-label="${escapeHtml(brand)} home">${wordmark(b.wordmarkDark, brand)}</a>
      <div class="auth-splash-copy">
        <p class="eyebrow">${escapeHtml(b.tagline)}</p>
        <h1>Make every hour visible.</h1>
        <p>Track the work, understand the week, and turn time into a clear record.</p>
      </div>
      <p class="auth-splash-foot">${escapeHtml(b.description)}</p>
    </div>
    <div class="auth-entry">
      <div class="auth-card">
        <div class="auth-checking" data-auth-checking role="status" aria-live="polite">
          <span aria-hidden="true"></span>
          <p>Checking your session…</p>
        </div>
        <form class="sign-in-form" data-sign-in-form method="post" action="/auth/sign-in" hidden>
          <div class="auth-heading">
            <p class="eyebrow">Welcome back</p>
            <h2 id="sign-in-title">Sign in to ${escapeHtml(brand)}</h2>
            <p>Use your account to continue to your workspace.</p>
          </div>
          ${providerSignIn(options.signInProviders ?? [], passwordSignIn)}
          <div class="password-entry" data-password-entry${passwordSignIn ? '' : ' hidden'}>
            <label for="ez-sign-in-email">Email
              <input id="ez-sign-in-email" name="email" type="email" inputmode="email" autocomplete="username" required>
            </label>
            <label for="ez-sign-in-password">Password
              <input id="ez-sign-in-password" name="password" type="password" autocomplete="current-password" required>
            </label>
            <button class="primary-action" type="submit" data-sign-in-submit>Sign in</button>
            <p class="auth-result" data-sign-in-result role="status" aria-live="polite"></p>
            ${demoCredentials(options.demoAccounts ?? [])}
          </div>
          ${passwordSignIn || (options.signInProviders ?? []).length > 0 ? '' : noSignInMethod(brand)}
        </form>
        <form class="sign-in-form" data-two-factor-form method="post" action="/auth/two-factor/challenge" hidden>
          <div class="auth-heading">
            <p class="eyebrow">One more step</p>
            <h2 id="two-factor-title">Enter your verification code</h2>
            <p>Open your authenticator app, or use one of your recovery codes.</p>
          </div>
          <label for="ez-two-factor-code">Verification code
            <input id="ez-two-factor-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" spellcheck="false" autocapitalize="off" required>
          </label>
          <button class="primary-action" type="submit" data-two-factor-submit>Verify</button>
          <button class="sign-in-restart" type="button" data-two-factor-cancel>Start over</button>
          <p class="auth-result" data-two-factor-result role="status" aria-live="polite"></p>
        </form>
        <noscript>${renderEmptyState('JavaScript is required', `The ${escapeHtml(brand)} app uses JavaScript to establish and protect your session.`)}</noscript>
      </div>
      <p class="auth-build-stamp">${escapeHtml(options.environment)} · ${escapeHtml(shortRelease)}</p>
    </div>
  </section>
  <aside class="session-check-overlay" data-session-check-overlay role="status" aria-live="polite" aria-atomic="true"${resumeSession ? '' : ' hidden'}>
    <div class="session-check-card">
      <span class="session-check-spinner" aria-hidden="true"></span>
      <p>Checking your session…</p>
    </div>
  </aside>
  <div class="authenticated-shell" data-authenticated-shell${resumeSession ? '' : ' hidden'} inert aria-busy="true">
  <!--
    One header, two layouts (the 2026-10 reskin): the stylesheet lays these
    same elements down the left or across the top, from data-ez-nav on the
    root. The collapse toggle only shows in the sidebar, and only at desktop
    width; below 900px both layouts fold into the Menu drawer.
  -->
  <header class="topbar" id="ez-app-nav" data-app-nav>
    <a class="brand" href="/dashboard" aria-label="${escapeHtml(brand)} home" data-home-link><span class="brand-wordmark">${wordmark(b.wordmarkDark, brand)}</span><span class="brand-glyph">${brand === defaultBrand.name && (b.wordmarkDark ?? '') === '' ? productLogo : iconMarkup('home')}</span></a>
    <button class="nav-collapse" type="button" data-sidebar-toggle aria-controls="ez-app-nav" aria-pressed="${sidebar === 'collapsed' ? 'true' : 'false'}" aria-label="Collapse sidebar">${iconMarkup('sidebar')}</button>
    <nav class="primary-nav" aria-label="Primary">${navigation}</nav>
    <button class="timer-chip" type="button" data-timer-chip data-state="loading" data-auth-action disabled aria-haspopup="dialog">
      ${iconMarkup('clock')}
      <span class="live-dot" aria-hidden="true"></span>
      <span data-timer-label>Timer</span>
      <span data-timer-elapsed>—</span>
    </button>
    <!--
      Search looks like the field it opens (the 2026-10 reskin). The key chip's
      modifier is filled in by the browser -- the command key on a Mac, Ctrl
      elsewhere -- because the server cannot tell which keyboard is in front of
      the page; both keys open the bar everywhere, so the name stays neutral
      and aria-keyshortcuts states both.
    -->
    <button class="command-trigger" type="button" data-command-trigger data-auth-action disabled aria-haspopup="dialog" aria-label="Search and commands" aria-keyshortcuts="Meta+K Control+K">${iconMarkup('magnifier')}<span class="command-trigger-label" aria-hidden="true">Search…</span><kbd class="command-shortcut" aria-hidden="true"><span data-command-modifier></span>K</kbd></button>
    <!--
      Masking is a display state, not a permission: the figures still arrive and
      the screens still total them, and this decides whether they are drawn. It
      renders pressed-out because shown is the default, and the browser sets it
      from storage before the first paint.
    -->
    <button class="money-toggle" type="button" data-money-toggle data-auth-action disabled aria-pressed="false" aria-label="Hide money amounts ($)" title="Hide money amounts ($)"><span aria-hidden="true">$</span></button>
    <button class="menu-trigger" type="button" data-menu-trigger aria-label="Open navigation" aria-haspopup="dialog">Menu</button>
    <div class="account" data-auth-shell data-state="loading">
      <div class="account-identity" data-current-identity hidden>
        <svg class="identity-avatar" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="8.5" r="3.25"/><path d="M5.75 19a6.25 6.25 0 0 1 12.5 0"/></svg>
        <span class="identity-text">
          <span class="visually-hidden">Signed in as </span><span class="identity-name" data-current-profile>—</span>
          <span class="identity-meta">User #<span data-current-user-id>—</span></span>
        </span>
        <a class="identity-settings" href="/settings/user" data-settings-link>${iconMarkup('sliders')}<span class="identity-action-label">Settings</span></a>
        <button type="button" class="identity-signout" data-logout>${iconMarkup('sign-out')}<span class="identity-action-label">Sign out</span></button>
        <p class="auth-result visually-hidden" data-logout-result role="status" aria-live="polite"></p>
      </div>
    </div>
  </header>
  ${renderTabStrip(options)}
  <main class="app-content page--grid" data-app-content${view === 'time' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">This week</p><h1>Time</h1></div>
      <!--
        An administrator's way into a teammate's week (issue 917). Hidden for
        everyone else, and filled once the session says who is asking.
      -->
      <label class="time-person" data-time-person-field hidden>Timesheet
        <select data-time-person disabled>
          <option value="">Yours</option>
        </select>
      </label>
      <button class="primary-action" type="button" data-command-trigger data-auth-action data-time-log-time disabled>Log time</button>
    </header>
    <aside class="time-person-banner" data-time-person-banner role="status" aria-live="polite" hidden>
      <strong data-time-person-banner-text></strong>
      <button type="button" data-time-person-reset>Back to your timesheet</button>
    </aside>
    <aside class="session-status" data-session-status role="status">
      <span data-session-message>Connecting to your ${escapeHtml(brand)} session…</span>
      <button type="button" data-retry-week hidden>Retry week</button>
    </aside>
    <section class="week-surface" aria-labelledby="week-heading">
      <header class="week-toolbar">
        <!--
          The mount point for the shared period control, which replaces the
          hand-rolled week stepper that stood here: the "Monday–Sunday" eyebrow
          (static text, and a lie on an organization whose week starts on
          Saturday), the "Week of …" label, and the two chevrons either side of
          the "This week" button. The control is week-only here because the grid
          below draws seven day columns and a month is not seven of anything.

          The heading stays as the section's accessible name. It is hidden
          because the control immediately below it says the same thing in a form
          the reader can also operate, and naming the week twice on one row is
          the noise §6 asks screens to stop making.
        -->
        <div class="week-period" data-week-period>
          <h2 class="visually-hidden" id="week-heading">Timesheet week</h2>
        </div>
        <div class="week-actions">
          <button type="button" data-week-current data-auth-action disabled>${iconMarkup('calendar')}This week</button>
          <button type="button" data-copy-last-week data-auth-action disabled>Copy last week</button>
          <button type="button" data-add-row-trigger data-auth-action disabled>Add row</button>
          <strong data-week-total>—</strong>
        </div>
      </header>
      <p class="week-hint" data-week-hint>Open any cell with its <span aria-hidden="true">✎</span> button, or <kbd>Alt</kbd>+<kbd>Enter</kbd> while it has focus, to edit the note or delete the entry. Clearing a cell to zero removes its entry.</p>
      <p class="week-removed" data-week-removed role="status" aria-live="polite" hidden></p>
      <aside class="timesheet-status" data-timesheet-status hidden aria-live="polite">
        <div>
          <p class="eyebrow">Timesheet approval</p>
          <strong data-timesheet-status-label>Not submitted</strong>
          <p data-timesheet-rejection-reason hidden></p>
          <p class="form-result" data-timesheet-result role="status"></p>
        </div>
        <div class="timesheet-status-actions">
          <button type="button" data-unsubmit-timesheet data-auth-action hidden disabled>Unsubmit week</button>
          <button type="button" data-withdraw-timesheet data-auth-action hidden disabled>Reopen week</button>
          <button class="primary-action" type="button" data-submit-timesheet data-auth-action disabled>Submit week</button>
        </div>
      </aside>
      <ol class="day-totals" data-day-totals aria-label="Hours by day"></ol>
      <div class="week-grid-wrap" data-week-grid data-view="desktop">
        <table class="week-grid-table">
          <thead data-week-grid-head><tr><th>Project / task</th><th colspan="8">Loading week…</th></tr></thead>
          <tbody data-week-grid-rows><tr><td colspan="9">Loading time entries…</td></tr></tbody>
          <tfoot data-week-grid-totals></tfoot>
        </table>
      </div>
      <section class="calendar-week" data-calendar-week aria-label="Calendar">
        <p class="form-result" data-calendar-status role="status" aria-live="polite">Loading calendar…</p>
        <div data-calendar-grid></div>
      </section>
      <div class="day-list" data-day-list data-view="phone">
        <header class="day-switcher">
          <button type="button" data-day-previous data-auth-action disabled aria-label="Previous day">${iconMarkup('chevron', { direction: 'left' })}</button>
          <strong data-day-label>—</strong>
          <button type="button" data-day-next data-auth-action disabled aria-label="Next day">${iconMarkup('chevron')}</button>
        </header>
        <div data-day-rows><p class="day-empty">Loading time entries…</p></div>
      </div>
    </section>
  </main>
  <main class="app-content timesheet-approvals page--grid" data-timesheet-approvals-page${view === 'timesheet-approvals' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Timesheets</p><h1>Approvals</h1></div>
      <a href="/">Back to time</a>
    </header>
    <section data-approval-review-panel>
      <p class="approval-intro">Review submitted time before it becomes locked.</p>
      <form class="approval-filters" data-approval-filters>
        <label>Person <select name="user_id" data-approval-filter-user><option value="">All</option></select></label>
        <label>Client <select name="client_id" data-approval-filter-client><option value="">All</option></select></label>
        <label>Project <select name="project_id" data-approval-filter-project><option value="">All</option></select></label>
        <button type="submit" class="filter-apply">Apply</button>
      </form>
      <p class="form-result" data-approval-queue-result role="status" aria-live="polite"></p>
      <section class="approval-queue" data-approval-queue aria-label="Pending timesheets"></section>
      <button type="button" class="load-more" data-approval-load-more hidden>Load more</button>
      <section class="approval-queue" data-approval-history aria-label="Recently approved timesheets"></section>
      <button type="button" class="load-more" data-approval-history-load-more hidden>Load more</button>
    </section>
    <section class="timesheet-lock-policy" data-lock-policy-panel hidden aria-labelledby="lock-policy-title">
      <header>
        <div><p class="eyebrow">Organization policy</p><h2 id="lock-policy-title">Time and expense locks</h2></div>
        <p>Deadline and manual locks remain in force until explicitly unlocked.</p>
      </header>
      <form class="org-timezone-form" data-org-timezone-form>
        <label>Organization timezone
          <select name="timezone" data-org-timezone required>
            <option value="">Select a timezone</option>
          </select>
        </label>
        <p class="field-hint">The day tracked work is filed on for anyone who has not set their own, and the timezone deadlines below are read in.</p>
        <button type="submit" data-org-timezone-submit>Save timezone</button>
        <p class="form-result" data-org-timezone-result aria-live="polite"></p>
      </form>
      <form class="lock-policy-form" data-lock-policy-form>
        <label class="lock-policy-toggle"><input name="autoLock" type="checkbox" data-lock-policy-auto>Automatically lock completed weeks</label>
        <label>Deadline day
          <select name="deadlineDay" data-lock-policy-day>
            <option value="sunday">Sunday</option><option value="monday">Monday</option>
            <option value="tuesday">Tuesday</option><option value="wednesday">Wednesday</option>
            <option value="thursday">Thursday</option><option value="friday">Friday</option>
            <option value="saturday">Saturday</option>
          </select>
        </label>
        <label>Deadline time<input name="deadlineTime" type="time" data-lock-policy-time required></label>
        <button class="primary-action" type="submit" data-lock-policy-submit>Save policy</button>
      </form>
      <form class="manual-lock-form" data-manual-lock-form>
        <div>
          <p class="eyebrow">One-time cutoff</p>
          <h3>Lock all tracked work through a date</h3>
        </div>
        <label>Locked through<input name="lockedThrough" type="date" data-manual-lock-through required></label>
        <label>Reason<textarea name="reason" data-manual-lock-reason rows="3" maxlength="10000" required></textarea></label>
        <button type="submit" data-manual-lock-submit>Create lock</button>
      </form>
      <p class="form-result" data-lock-policy-result role="status" aria-live="polite"></p>
      <div class="timesheet-lock-list" data-timesheet-lock-list aria-live="polite"></div>
    </section>
  </main>
  <main class="app-content invoice-workspace page--grid" data-invoice-list-page${view === 'invoice-list' || view === 'invoice-generation' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Money</p><h1>Invoices</h1></div>
      <a class="primary-action invoice-create-link" href="/invoices/new" data-invoice-new>+ New invoice</a>
    </header>
    <p class="invoice-intro">Browse generated and imported invoices. Amounts are shown in each invoice's own currency.</p>
    <div class="invoice-list-toolbar">
      <fieldset aria-label="Invoice state">
        <legend class="visually-hidden">Invoice state</legend>
        <button type="button" data-invoice-filter="outstanding" aria-pressed="true">Outstanding</button>
        <button type="button" data-invoice-filter="overdue" aria-pressed="false">Past due</button>
        <button type="button" data-invoice-filter="paid" aria-pressed="false">Paid</button>
        <button type="button" data-invoice-filter="closed" aria-pressed="false">Closed</button>
        <button type="button" data-invoice-filter="all" aria-pressed="false">All</button>
      </fieldset>
      <label for="ez-invoice-search">Search by invoice number or client
        <input id="ez-invoice-search" type="search" data-invoice-search autocomplete="off" placeholder="INV-1024 or client">
      </label>
    </div>
    <p class="form-result invoice-page-status" data-invoice-list-status role="status" aria-live="polite">Loading invoices…</p>
    <section class="invoice-list" data-invoice-list aria-label="Invoices"></section>
    <button class="invoice-load-more" type="button" data-invoice-load-more hidden>Load more invoices</button>
  </main>
  <main class="app-content invoice-workspace page--grid" data-invoice-detail-page${view === 'invoice-detail' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Invoices</p><h1>Invoice detail</h1></div>
      <a href="/invoices">Back to invoices</a>
    </header>
    <p class="form-result invoice-page-status" data-invoice-detail-status role="status" aria-live="polite">Loading invoice…</p>
    <button class="invoice-load-more" type="button" data-invoice-detail-retry hidden>Retry invoice</button>
    <article class="invoice-document" data-invoice-document data-document-shell data-ez-theme="${defaultTheme}" hidden>
      <header class="invoice-document-heading">
        <div>
          <p class="eyebrow">Invoice</p>
          <h2 data-invoice-detail-number>—</h2>
          <p data-invoice-detail-subject hidden></p>
        </div>
        <div class="invoice-document-actions"><strong class="invoice-state" data-invoice-detail-state>—</strong><button type="button" data-invoice-print>Print</button><div class="invoice-overflow invoice-hours-export" data-invoice-hours-export hidden><button type="button" data-invoice-hours-toggle aria-haspopup="true" aria-expanded="false" aria-controls="ez-invoice-hours-menu">Export hours</button><div class="invoice-overflow-menu" id="ez-invoice-hours-menu" data-invoice-hours-menu role="menu" hidden><p class="invoice-hours-menu-label">Every entry</p><button class="invoice-overflow-item" type="button" role="menuitem" data-hours-format="pdf" data-hours-detail="detailed">PDF</button><button class="invoice-overflow-item" type="button" role="menuitem" data-hours-format="csv" data-hours-detail="detailed">CSV</button><button class="invoice-overflow-item" type="button" role="menuitem" data-hours-format="xlsx" data-hours-detail="detailed">Excel</button><p class="invoice-hours-menu-label">Summary</p><button class="invoice-overflow-item" type="button" role="menuitem" data-hours-format="pdf" data-hours-detail="summary">PDF</button><button class="invoice-overflow-item" type="button" role="menuitem" data-hours-format="csv" data-hours-detail="summary">CSV</button><button class="invoice-overflow-item" type="button" role="menuitem" data-hours-format="xlsx" data-hours-detail="summary">Excel</button></div></div><a class="invoice-edit-link" data-invoice-edit aria-disabled="true" hidden>Edit invoice</a><button type="button" data-invoice-send disabled hidden>Send invoice</button><button type="button" data-invoice-quickbooks-sync disabled hidden>Sync to QuickBooks</button><button type="button" class="primary-action" data-invoice-payment-settle data-auth-action disabled hidden>Mark paid</button>${renderInvoiceOverflowMenu()}</div>
      </header>
      <p class="invoice-reminder-line" data-invoice-reminder-line hidden></p>
      <dl class="invoice-facts">
        <div><dt>Client</dt><dd data-invoice-detail-client>—</dd></div>
        <div><dt>Issued</dt><dd data-invoice-detail-issued>—</dd></div>
        <div><dt>Due</dt><dd data-invoice-detail-due-date>—</dd></div>
        <div><dt>Period</dt><dd data-invoice-detail-period>—</dd></div>
        <div><dt>Purchase order</dt><dd data-invoice-detail-purchase-order>—</dd></div>
        <div data-invoice-quickbooks-fact hidden><dt>QuickBooks</dt><dd data-invoice-detail-quickbooks>—</dd></div>
        <div data-invoice-reminders-fact hidden><dt>Reminders</dt><dd><span data-invoice-detail-reminders>—</span> <label class="invoice-reminders-switch"><input type="checkbox" data-invoice-reminders-toggle> Send payment reminders</label></dd></div>
      </dl>
      ${renderInvoiceLineEditor()}
      <div class="invoice-line-wrap">
        <table class="invoice-line-table">
          <thead><tr><th scope="col">Description</th><th scope="col">Quantity</th><th scope="col">Rate</th><th scope="col">Amount</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody data-invoice-detail-lines></tbody>
        </table>
      </div>
      <dl class="invoice-totals">
        <div><dt>Discount</dt><dd class="money" data-invoice-detail-discount>—</dd></div>
        <div><dt>Tax</dt><dd class="money" data-invoice-detail-tax>—</dd></div>
        <div><dt>Total</dt><dd class="money" data-invoice-detail-total>—</dd></div>
        <div><dt>Amount due</dt><dd class="money" data-invoice-detail-due>—</dd></div>
      </dl>
      <section class="invoice-notes" data-invoice-detail-notes-section hidden>
        <h3>Notes</h3><p data-invoice-detail-notes></p>
      </section>
      ${renderInvoicePaymentSection()}
      ${renderInvoiceAttachmentSection()}
      <section class="invoice-history" aria-labelledby="invoice-message-heading">
        <h3 id="invoice-message-heading">History</h3>
        <ul data-invoice-detail-messages></ul>
      </section>
    </article>
  </main>
  ${renderInvoiceEditPage(view)}
  <!--
    New invoice is one step, as it was in Harvest: who, and whether the draft is
    filled from tracked work, charges a flat fee that covers it, or starts
    empty. Everything after that is the draft.
    It hangs off the invoice list; /invoices/new is the same list with the dialog
    already open, so a report handoff and the command palette still land here.
  -->
  <dialog class="invoice-new-dialog" data-invoice-new-dialog aria-labelledby="invoice-new-title">
    <form class="invoice-generation-form" data-invoice-generation-form method="dialog" novalidate>
      <header>
        <div><p class="eyebrow">Invoices</p><h2 id="invoice-new-title">New invoice</h2></div>
        <button type="button" data-dialog-close aria-label="Close new invoice dialog">×</button>
      </header>
      <div class="invoice-new-body">
        <label for="ez-invoice-client">Client
          <select id="ez-invoice-client" name="client" data-invoice-client required autofocus></select>
        </label>
        <fieldset class="invoice-new-kind">
          <legend>Type</legend>
          <label class="invoice-new-kind-card">
            <input type="radio" name="kind" value="tracked" data-invoice-kind checked>
            <span><strong>From tracked time &amp; expenses</strong><small>Fill the draft from uninvoiced work</small></span>
          </label>
          <label class="invoice-new-kind-card">
            <input type="radio" name="kind" value="free_form" data-invoice-kind>
            <span><strong>Free form</strong><small>Start empty and add your own lines</small></span>
          </label>
          <label class="invoice-new-kind-card invoice-new-kind-wide">
            <input type="radio" name="kind" value="banded" data-invoice-kind>
            <span><strong>Flat fee covering tracked time</strong><small>A fixed fee that covers the hours; bill any overage</small></span>
          </label>
        </fieldset>
        <div class="invoice-new-tracked" data-invoice-tracked>
          <fieldset class="invoice-new-section">
            <legend>Projects</legend>
            <div class="invoice-projects" data-invoice-projects role="group" aria-label="Projects">
              <p class="hint">Choose a client to see its projects.</p>
            </div>
          </fieldset>
          <fieldset class="invoice-new-section">
            <legend>Period</legend>
            <div class="invoice-new-period-choice">
              <label><input type="radio" name="period" value="all" data-invoice-period-choice checked> All uninvoiced</label>
              <label><input type="radio" name="period" value="range" data-invoice-period-choice> Date range</label>
            </div>
            <!--
              The shared period control, mounted by the browser: one implementation,
              built once, rather than a string copy here to keep in step with it.
            -->
            <div class="invoice-period" data-invoice-period hidden></div>
          </fieldset>
          <div class="invoice-new-tracked-only" data-invoice-tracked-only>
            <div class="invoice-new-detail">
              <label for="ez-invoice-time-summary">Group time by
                <select id="ez-invoice-time-summary" name="timeSummary">
                  <option value="project">Project</option>
                  <option value="task">Task</option>
                  <option value="people">Person</option>
                  <option value="detailed">Detailed (one line per entry)</option>
                  <option value="">Do not include time</option>
                </select>
              </label>
              <label for="ez-invoice-expense-summary">Expenses
                <select id="ez-invoice-expense-summary" name="expenseSummary" data-invoice-expense-summary aria-describedby="ez-invoice-expense-hint">
                  <option value="project">Group by project</option>
                  <option value="category">Group by category</option>
                  <option value="people">Group by person</option>
                  <option value="detailed">Detailed (one line per expense)</option>
                  <option value="">Do not include expenses</option>
                </select>
              </label>
            </div>
            <p class="field-hint" id="ez-invoice-expense-hint" data-invoice-expense-hint hidden></p>
          </div>
          <!--
            A band: the fee, then how much of the period's time it covers. The
            claim itself is the server's (the recurring engine's own rule), so
            the preview here says only what the uninvoiced report can stand
            behind and leaves the exact split to the draft.
          -->
          <div class="invoice-new-band" data-invoice-band hidden>
            <fieldset class="invoice-new-section">
              <legend>Fee</legend>
              <div class="invoice-fee-lines" data-invoice-fee-lines></div>
              <div class="invoice-fee-foot">
                <button type="button" data-invoice-fee-add>Add line</button>
                <p>Fee <strong class="money" data-invoice-fee-total>—</strong></p>
              </div>
            </fieldset>
            <fieldset class="invoice-new-section">
              <legend>Covers</legend>
              <div class="invoice-new-period-choice">
                <label><input type="radio" name="claimMode" value="all" data-invoice-claim-mode checked> All of the time</label>
                <label><input type="radio" name="claimMode" value="ceiling" data-invoice-claim-mode> Up to a limit</label>
              </div>
              <div class="invoice-new-ceiling" data-invoice-ceiling hidden>
                <label for="ez-invoice-ceiling-unit">Limit in
                  <select id="ez-invoice-ceiling-unit" name="ceilingUnit" data-invoice-ceiling-unit>
                    <option value="hours">Hours</option>
                    <option value="value">Value</option>
                  </select>
                </label>
                <label for="ez-invoice-ceiling">Up to
                  <input id="ez-invoice-ceiling" name="ceiling" data-invoice-ceiling-amount inputmode="decimal" autocomplete="off" aria-describedby="ez-invoice-ceiling-hint">
                </label>
                <p class="field-hint invoice-new-ceiling-hint" id="ez-invoice-ceiling-hint" data-invoice-ceiling-hint></p>
                <label class="invoice-new-overage" for="ez-invoice-overage-summary">Bill the hours past the limit, grouped by
                  <select id="ez-invoice-overage-summary" name="overageSummary" data-invoice-overage-summary>
                    <option value="project">Project</option>
                    <option value="task">Task</option>
                    <option value="people">Person</option>
                    <option value="detailed">Detailed (one line per entry)</option>
                  </select>
                </label>
                <p class="field-hint invoice-new-overage">The oldest hours are covered first. An entry that would cross the limit is billed whole at its person's rate, never split.</p>
              </div>
            </fieldset>
            <p class="invoice-band-preview" data-invoice-band-preview role="status" aria-live="polite"></p>
            <p class="field-hint">Expenses are not part of the fee and stay uninvoiced for a later invoice.</p>
          </div>
          <div class="invoice-new-journal">
            <label class="invoice-new-check"><input type="checkbox" name="attachJournal" data-invoice-attach-journal> Attach an hours report when this invoice is emailed</label>
            <label class="visually-hidden" for="ez-invoice-journal-level">Hours report detail</label>
            <select id="ez-invoice-journal-level" name="journalLevel" data-invoice-journal-level hidden>
              <option value="detailed">Every entry</option>
              <option value="summary">Summary</option>
            </select>
            <fieldset class="invoice-new-formats" data-invoice-journal-formats hidden>
              <legend class="visually-hidden">Hours report formats</legend>
              <label><input type="checkbox" name="journalFormat" value="pdf" checked> PDF</label>
              <label><input type="checkbox" name="journalFormat" value="csv"> CSV</label>
              <label><input type="checkbox" name="journalFormat" value="xlsx"> Excel</label>
            </fieldset>
          </div>
        </div>
        <p class="form-result" data-invoice-generation-result role="status" aria-live="polite"></p>
      </div>
      <template data-invoice-fee-line-template>
        <div class="invoice-fee-line" data-invoice-fee-line role="group">
          <label class="invoice-fee-description">Description<input name="feeDescription" data-invoice-fee-description autocomplete="off" maxlength="100000"></label>
          <label>Quantity<input name="feeQuantity" data-invoice-fee-quantity inputmode="decimal" autocomplete="off" value="1"></label>
          <label>Unit price<input name="feeUnitPrice" data-invoice-fee-unit-price inputmode="decimal" autocomplete="off" placeholder="0.00"></label>
          <p class="invoice-fee-amount"><span>Amount</span><strong class="money" data-invoice-fee-amount>—</strong></p>
          <button type="button" class="invoice-fee-remove" data-invoice-fee-remove>Remove</button>
        </div>
      </template>
      <footer>
        <button type="button" data-retry-invoice-catalog hidden>Retry loading clients and projects</button>
        <button type="button" data-dialog-close>Cancel</button>
        <button class="primary-action" type="submit" data-invoice-generation-submit data-auth-action disabled>Create draft</button>
      </footer>
    </form>
  </dialog>
  ${renderRecurringPage(view)}
  ${renderRecurringEditorPage(view)}
  ${renderEstimatesPage(view)}
  ${renderRetainerPage(view)}
  ${renderEmailConfigPage(view)}
  ${renderClientDirectoryPages(view)}
  ${renderTeamPages(view)}
  ${renderProjectDirectoryPages(view)}
  ${renderTaskAdminPage(view)}
  ${renderDashboardPage(view)}
  ${renderReportsPage(view)}
  ${renderStaffPayments(view)}
  ${renderExpenseWorkflowPages(view)}
  ${renderExpenseCategoriesPage(view)}
  ${renderModuleSettingsPage(view)}
  ${renderActivityLogPage(view)}
  ${renderDeliveriesPage(view)}
  ${renderRoleAdminPage(view)}
  ${renderNotFoundPage(view)}
  ${renderInvoiceComposerDialog()}
  ${renderInvoicePaymentDialogs()}
  ${renderInvoiceTransitionDialog()}
  ${renderRetainerDialogs()}
  <dialog class="command-dialog" data-command-dialog aria-labelledby="command-title">
    <form data-command-form>
      <header><div><p class="eyebrow">Command bar</p><h2 id="command-title">Go or log time</h2></div><button type="button" data-dialog-close aria-label="Close">×</button></header>
      <label for="ez-command" class="visually-hidden">Command</label>
      <div class="command-query">${iconMarkup('magnifier')}<input id="ez-command" name="command" autocomplete="off" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="ez-command-results" placeholder="Search, or log 2h northpeak devops" required></div>
      <div class="command-results" id="ez-command-results" data-command-results role="listbox" aria-label="Destinations"></div>
      <p class="form-result" data-command-result role="status"></p>
      <!--
        The keys as keys (issue 859). The sentence this replaces wrapped to two
        lines at the dialog's own width, and it left Shift+Enter out. Nothing
        here is wired: the handlers on the input own every one of these.
      -->
      <div class="command-footer">
        <p class="hint command-keys"><span><kbd>↑</kbd><kbd>↓</kbd> Choose</span> <span><kbd>Enter</kbd> Go</span> <span><kbd>Shift</kbd>+<kbd>Enter</kbd> Log time</span> <span><kbd>Esc</kbd> Close</span></p>
        <button class="primary-action" type="submit">Run command</button>
      </div>
    </form>
  </dialog>
  <dialog class="entry-dialog" data-entry-dialog data-timer-dialog data-note-dialog aria-labelledby="entry-title">
    <form data-timer-form novalidate data-entry-form data-note-form>
      <header><div><p class="eyebrow" data-entry-context>Time entry</p><h2 id="entry-title" data-entry-title data-note-title>Log time</h2></div><button type="button" data-dialog-close aria-label="Close">×</button></header>
      <div class="entry-assignment">
        <label>Project<select name="project" data-entry-project data-entry-project-options required></select></label>
        <label>Task<select name="task" data-entry-task data-entry-task-options required></select></label>
      </div>
      <label>Date<input name="spent_date" data-entry-date type="date" required></label>
      <label data-entry-duration>Duration<input name="duration" data-entry-duration-input inputmode="decimal" autocomplete="off"></label>
      <div class="entry-times" data-entry-times hidden>
        <label>Start<input name="started_time" data-entry-start autocomplete="off" placeholder="9:00 AM"></label>
        <label>End<input name="ended_time" data-entry-end autocomplete="off" placeholder="5:00 PM"></label>
      </div>
      <p class="hint" data-entry-running hidden>This entry is running. Stop it before changing its assignment or timing.</p>
      <label for="ez-entry-note">Note<textarea id="ez-entry-note" name="notes" data-entry-note-input data-timer-note data-note-input rows="5" maxlength="10000" aria-describedby="note-hint note-result"></textarea></label>
      <p class="hint" id="note-hint" data-entry-note-hint data-timer-note-hint data-note-hint>Optional. Up to 10,000 characters.</p>
      <p class="form-result" id="note-result" data-entry-result data-timer-result data-note-result role="status"></p>
      <div class="timer-actions"><button class="primary-action" type="submit" data-entry-submit>Save entry</button><button type="button" data-stop-timer hidden>Stop running timer</button><button type="button" class="danger-action" data-entry-delete hidden>Delete entry</button></div>
    </form>
  </dialog>
  <dialog class="menu-dialog" data-menu-dialog aria-labelledby="menu-title">
    <header><div><p class="eyebrow">Menu</p><h2 id="menu-title">Navigate</h2></div><button type="button" data-dialog-close aria-label="Close">×</button></header>
    <nav aria-label="Mobile primary">${navigation}</nav>
    <nav class="secondary-nav" data-secondary-nav aria-label="More">${foldedNavigation}</nav>
    <!--
      The layout switch, where the navigation is (the 2026-10 reskin). Settings
      carries the same pair beside the theme; both write one cookie.
    -->
    <div class="menu-layout" role="group" aria-label="Navigation">
      <span class="menu-layout-label" aria-hidden="true">Navigation</span>
      <button type="button" data-nav-layout-choice="sidebar" aria-pressed="${navLayout === 'sidebar' ? 'true' : 'false'}">Sidebar</button>
      <button type="button" data-nav-layout-choice="topbar" aria-pressed="${navLayout === 'topbar' ? 'true' : 'false'}">Top bar</button>
    </div>
    <!--
      The dialog's footer (issue 859). The form is the footer rather than being
      wrapped in one: the stylesheet gives it the band, and the browser code
      and the timezone tests address it by its own attributes.
    -->
    <form class="profile-timezone-form" data-profile-timezone-form>
      <label>Your timezone
        <select name="timezone" data-profile-timezone required>
          <option value="">Select a timezone</option>
        </select>
      </label>
      <p class="field-hint" data-profile-timezone-hint></p>
      <button type="submit" data-profile-timezone-submit>Save timezone</button>
      <p class="form-result" data-profile-timezone-result aria-live="polite"></p>
    </form>
  </dialog>
  <dialog class="row-dialog" data-row-dialog aria-labelledby="row-title">
    <form data-row-form>
      <header><div><p class="eyebrow">Timesheet row</p><h2 id="row-title">Add project and task</h2></div><button type="button" data-dialog-close aria-label="Close">×</button></header>
      <label>Project<select name="project" data-row-project required></select></label>
      <label>Task<select name="task" data-row-task required></select></label>
      <p class="form-result" data-row-result role="status"></p>
      <button class="primary-action" type="submit">Add row</button>
    </form>
  </dialog>
  <dialog class="rejection-dialog" data-rejection-dialog aria-labelledby="rejection-title">
    <form data-rejection-form novalidate>
      <header><div><p class="eyebrow">Return timesheet</p><h2 id="rejection-title">Reason for rejection</h2></div><button type="button" data-dialog-close aria-label="Close">×</button></header>
      <label for="ez-rejection-reason">What needs to change?<textarea id="ez-rejection-reason" name="reason" data-rejection-reason rows="5" maxlength="10000" required></textarea></label>
      <p class="hint">Required. This reason is shown to the person who submitted the timesheet.</p>
      <p class="form-result" data-rejection-result role="status" aria-live="polite"></p>
      <button class="primary-action" type="submit" data-rejection-submit>Reject timesheet</button>
    </form>
  </dialog>
  <dialog class="rejection-dialog" data-withdrawal-dialog aria-labelledby="withdrawal-title">
    <form data-withdrawal-form novalidate>
      <header><div><p class="eyebrow">Explicit unlock</p><h2 id="withdrawal-title">Reopen approved timesheet</h2></div><button type="button" data-dialog-close aria-label="Close">×</button></header>
      <label for="ez-withdrawal-reason">Why is this period being reopened?<textarea id="ez-withdrawal-reason" name="reason" data-withdrawal-reason rows="5" maxlength="10000" required></textarea></label>
      <p class="hint">Required. This action and reason are written to the audit stream.</p>
      <p class="form-result" data-withdrawal-result role="status" aria-live="polite"></p>
      <button class="primary-action" type="submit" data-withdrawal-submit>Reopen timesheet</button>
    </form>
  </dialog>
  <footer class="build-stamp">${escapeHtml(options.environment)} · ${escapeHtml(shortRelease)}</footer>
  </div>
</body>
</html>`
}

export const webAssets = {
  stylesheet: shellStylesheet,
  javascript: shellJavascript,
} as const
