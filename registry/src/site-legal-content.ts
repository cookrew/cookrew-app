import { FUNNEL_EVENTS, FUNNEL_PAYLOAD_KEYS, TELEMETRY_DEFAULT_ON } from '../../src/shared/funnel-events'
import { DELETE_ACCOUNT_KEEPS, DELETE_ACCOUNT_TAKES } from '../../src/shared/account-delete'
import { GITHUB_REPO, FACTS } from './site-content'
import { REACH_TTL_MS as DNS_CARD_TTL_MS } from './dns-zone'
import { KEEP_DAYS as FUNNEL_KEEP_DAYS } from './funnel-counts'
import { KEEP_DAYS as PULSE_KEEP_DAYS } from './pulse'
import { EXPIRED_RETENTION_MS } from './terms'
import { REVOKED_MAX, SESSIONS_MAX } from './v2-accounts'
import { PER_ACCOUNT as EVENTS_KEPT } from './v2-events'
import { JOIN_CODE_TTL_MS } from './v2-join-codes'
import { SEEN_KEEP_MS } from './v2-line-seen'
import { PENDING_TTL_MS } from './v2-pending'
import { REACH_TTL_MS, SEAT_TTL_MS } from './v2-requests'
import { SEATS_MAX } from './v2-seats'
import { SESSION_TTL_MS } from './v2-tokens'

/**
 * THE LEGAL WORDS — /privacy and /terms, written from what the code does.
 *
 * Kept apart from site-content.ts because that file promises "nothing here is
 * a claim about the future", and these pages must describe two things that do
 * not exist yet. A section that does is `planned`, which the renderer turns
 * into a marked panel; its text must also say so in its own first line, since
 * a sentence gets quoted without its panel.
 *
 * A retention figure with a constant in the registry is read from it, so
 * changing that limit changes the page. Everything else has to be re-read by
 * hand when its code moves: what the relay can read, what a preset's limit or
 * price gates, and the app's own 30-day sweep. What a delete takes is read from
 * src/shared/account-delete.ts, the same list the app shows.
 *
 * The three placeholders are filled here, once. Until then the renderer marks
 * them on the page.
 */

/** A list of sentences as one run of text inside a sentence of its own. */
const asOneRun = (lines: readonly string[]): string => lines.join(' ')

export const LEGAL_ENTITY = '[LEGAL ENTITY]'
export const CONTACT_EMAIL = '[CONTACT EMAIL]'
export const GOVERNING_LAW = '[GOVERNING LAW]'

const UPDATED = '2026-11-05'
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
const days = (ms: number): number => ms / DAY_MS
const hours = (ms: number): number => ms / HOUR_MS
const minutes = (ms: number): number => ms / MINUTE_MS

export type LegalBlock =
  | { readonly p: string }
  | { readonly ul: readonly string[] }
  | { readonly table: { readonly head: readonly string[]; readonly rows: readonly (readonly string[])[] } }

export interface LegalSection {
  readonly id: string
  readonly heading: string
  /** Not live. Rendered as a marked panel, and must say so in its first line. */
  readonly planned?: boolean
  readonly blocks: readonly LegalBlock[]
}

export interface LegalDoc {
  readonly title: string
  readonly lede: string
  readonly updated: string
  readonly sections: readonly LegalSection[]
}

const FUNNEL_DEFAULT = TELEMETRY_DEFAULT_ON
  ? 'On by default. You can turn it off from the row in the app’s ⋯ menu, and while it is off these steps are counted on your machine only.'
  : 'Off by default. The app sends nothing here unless you turn on the row in its ⋯ menu. While it is off, these steps are counted on your machine only.'

export const PRIVACY: LegalDoc = {
  title: 'Privacy policy',
  lede: 'What cookrew.dev keeps about you, what it never keeps, and what passes through it.',
  updated: UPDATED,
  sections: [
    {
      id: 'short',
      heading: 'The short version',
      blocks: [
        {
          ul: [
            'Cookrew is a desktop app. Your code, prompts, terminals and transcripts live on your own machines, and cookrew.dev does not store them, apart from anything you choose to publish in a preset.',
            'A cookrew.dev account is a username and a password. The site does not ask for an email address.',
            'There are no ads, no third-party analytics scripts and no tracking cookies here, and we do not sell personal data.',
            'Calls to a served team that travel over the relay are sealed end to end, so the relay cannot read them.',
            'One exception you should know about: reaching your own Mac through the relay is not end-to-end encrypted yet. See “What passes through the relay”.',
            'Whatever you choose to publish, such as a team listing or a preset, is public, apart from the files of a preset you limit or price.'
          ]
        }
      ]
    },
    {
      id: 'scope',
      heading: 'Who we are and what this covers',
      blocks: [
        {
          p: `cookrew.dev is run by ${LEGAL_ENTITY} (“we”). This policy covers the website, the registry behind it and the relay. You can reach us at ${CONTACT_EMAIL}.`
        },
        {
          p: 'The Cookrew desktop app is open source and runs on your machine. It talks to cookrew.dev only for what is described here: your account, your desktop record, the marketplace, the teams you serve and the relay, plus the setup counts if you turn them on. The agent tools you run inside it, such as Claude Code and Codex, use your own logins with their own providers, and those providers’ policies apply.'
        },
        { p: `This policy was written from the registry’s source code, which you can read at ${GITHUB_REPO}.` }
      ]
    },
    {
      id: 'stored',
      heading: 'What the registry stores',
      blocks: [
        { p: 'These are the records about people in the registry’s data files.' },
        {
          table: {
            head: ['Record', 'What is in it', 'Who can see it'],
            rows: [
              [
                'Account',
                'Username, a scrypt hash of your password, the display name and avatar if you set them, and when the name was claimed.',
                'Username, display name and avatar are public. The rest is not.'
              ],
              [
                'Sign-in factors',
                'Hashed recovery codes, passkey public keys, and your authenticator (TOTP) secret if you set one up. The registry has to be able to read that secret to check your codes.',
                'Only the registry uses these.'
              ],
              [
                'Devices',
                'Device ID, kind (desktop, phone or browser), the device’s name, its public key, and when it was added and last seen.',
                'Your own devices. A team you call receives the calling device’s ID in your call token, and a Mac with a certificate has its ID in a public name (see “Who else sees your data”).'
              ],
              [
                'Sessions',
                'Session ID, which device it is on and when it was issued, plus the IDs of sessions and devices you have ended.',
                'Your own devices. Ended IDs are published so a team’s machine can refuse them. They are random, and the list carries no usernames.'
              ],
              [
                'Desktops',
                'For each machine you attach: its name, your workspace names and IDs (never their contents), which teams it holds, its hardware and OS profile (kind, model and label, vendor, OS version, architecture, CPU count, memory, and the probe facts behind the kind), the app version, when its relay line was last seen, and a signed card of its private network addresses (LAN and tailnet) with their certificate fingerprints.',
                'Your own devices.'
              ],
              [
                'Served teams',
                'Owner, team name and title, the name of its lead agent, the number of agents, its address and how it is reached, its access type, price and payment rails, its public seal key, and the summary, tags and agent tool names the owner wrote.',
                'Public, including as data at /v1/doors. A team on the relay lists the relay’s address, so your home network is not exposed. A team listed on a direct address publishes that address. When it was last refreshed, whether it is live and today’s line and call counts are public too.'
              ],
              [
                'Seats',
                'Team, account, whether the seat was bought or granted, who granted it or which payment rail settled it, its start, expiry and end, and a receipt reference.',
                'You and the team’s owner, apart from the receipt reference, which nobody is shown. Guests seated at the same team see your username.'
              ],
              [
                'Stripe references',
                'For a seat paid by card: the word “stripe” and the Stripe Checkout Session ID the team’s owner reports. For a seat paid over x402: “x402” and a short digest of the payment. Nothing else about the payment.',
                'No page or API shows the reference. It stays in the registry’s records as the link between a seat and its payment.'
              ],
              ['Stars', 'Your account, the team and when you starred it.', 'The count is public. Which teams you starred is not.'],
              [
                'Published presets',
                'The preset’s manifest and files: its card names, notes, roles, agent commands and prompts, and browser card URLs, with paths under your workdirs and home folder masked and a secret scan before publishing. Also an entry in a transparency log: the preset, its version, the author key, the publishing identity and the time.',
                'A free preset is public. The log and the list of presets are public for every preset, limited or priced included. An author can limit a preset to signed-in accounts or price it, and that gates both its manifest and its files. Anyone who gets a copy can pass it on, so a limit or a price does not keep anything secret.'
              ],
              [
                'Preset sales',
                'If you sell or buy a priced preset: the seller’s payout wallet address, the buyer’s receipt (account, preset, version, transaction reference, amount and time), and a record of each price quote (a single-use code, who and what it was for, and when it expires).',
                'Buyers see the payout address in the price quote. Receipts stay private.'
              ],
              [
                'Certificates',
                'If your Mac asks for a certificate: the certificate chain, and a count of recent orders.',
                'Certificates are public by nature. See “Who else sees your data”.'
              ],
              ['Older accounts', 'Accounts from before passwords: the handle and its public key.', 'Only the registry uses these.']
            ]
          }
        }
      ]
    },
    {
      id: 'counts',
      heading: 'Visit counts',
      blocks: [
        {
          p: 'The registry counts what happens on the site per UTC day: views of each page, and lines opened and calls carried to each served team. A count names the page or team, which can include its owner’s username, and never the visitor: it holds no caller account, no cookie and no network address.'
        }
      ]
    },
    {
      id: 'funnel',
      heading: 'Setup counts from the app',
      blocks: [
        { p: FUNNEL_DEFAULT },
        {
          p: `When it is on, the app sends each of five setup steps once per install: ${FUNNEL_EVENTS.join(', ')}. If the registry’s answer is lost the app retries, so a step can occasionally be counted twice. The paid step comes from the seller’s app, never the buyer’s.`
        },
        {
          p: `Each one carries exactly five fields (${FUNNEL_PAYLOAD_KEYS.join(', ')}): the step, the app version, the OS family, a random install ID tied to nothing else, and the UTC day. The registry refuses anything with more. Prompts, paths, names and output are never part of it.`
        },
        {
          p: 'The registry checks the install ID and then drops it. It keeps only a daily total per step, OS family and app version, so it cannot say which install got how far. The registry uses your network address for rate limiting in a keyed form that dies with the process, and never writes it down. The web logs described under “Server logs” are separate.'
        }
      ]
    },
    {
      id: 'never',
      heading: 'What the registry never stores',
      blocks: [
        {
          ul: [
            'Your prompts, transcripts, terminal output, code, files, file paths or canvases, unless you publish part of a canvas in a preset (see “What the registry stores”). The relay passes traffic through memory and writes none of it to disk.',
            'Card numbers, bank details, billing addresses or wallet private keys.',
            'Your logins or API keys for Claude, Codex or any other agent provider.',
            'Email addresses, phone numbers or postal addresses. The site does not ask for them.',
            'Plain-text passwords or recovery codes. A password arrives over TLS, is checked against or turned into its hash, and is not written down.',
            `Your public IP address in any data file, or your location. The registry does no geolocation. It holds your address in memory for rate limiting, and shows it to your own devices for the ${minutes(PENDING_TTL_MS)} minutes a sign-in can wait for their approval.`,
            'Advertising IDs or browser fingerprints.'
          ]
        }
      ]
    },
    {
      id: 'relay',
      heading: 'What passes through the relay',
      blocks: [
        {
          p: 'The relay exists because a machine at home usually cannot be dialled from outside. Your machine holds a line open to cookrew.dev and traffic travels down it. There are two kinds of traffic, and they are not equally private.'
        },
        {
          p: `Calls carried by the relay are sealed. Your browser or app encrypts every request and reply to the team’s own key (${FACTS.relayCipher}), and only the team’s machine can open them, so the relay cannot read them. It can see the outside of each exchange: which team, the request method and path, how many bytes, the status of the answer, and when. While a call is open it can also see who is calling: your IP address, your session cookie if you are signed in, and the call token the registry issues you. The registry stores none of that. The web logs described under “Server logs” are separate.`
        },
        {
          p: 'In a browser, this rests on cookrew.dev serving the team’s real key and honest encryption code, because both come from this site. The app also takes a team’s key from the registry the first time it imports that team. A team listed on a direct network address is called straight at that address, without the relay and without this seal, so its protection depends on how that address is served.'
        },
        {
          p: 'Reaching your own Mac through cookrew.dev is not end-to-end encrypted yet, wherever you are. OPEN on your account page always starts on this path, even at home. The app can move to a direct connection when it finds one, and shows which path it is on, but the app itself loads through the relay and traffic stays there until then. Even after the move, images and uploads keep using the relay, and everything returns to it if the direct link drops.'
        },
        {
          p: 'On this path the connection is encrypted on each side of the relay, but the registry process handles the traffic in readable form while it forwards it: your canvas, terminal output, transcripts and pairing token. The registry does not log or store that content, but whoever operates the relay could technically read it, so do not treat this path as private from us. Current versions of the app send your pairing token in a header on this path, not in an address, so the web logs described under “Server logs” do not record it. A Mac on an older version still puts it in the address of some live streams, and those logs can record that, so update the app and change your pairing token if that worries you. Only a connection that never goes through the relay avoids all of this, such as opening the app at your Mac’s own address on your Wi-Fi or tailnet.'
        },
        { p: 'Neither kind of traffic is written to the registry’s disk. It is held in memory only long enough to forward it.' }
      ]
    },
    {
      id: 'logs',
      heading: 'Server logs',
      blocks: [
        {
          p: 'The registry prints operational lines to its log. For a call to a served team: the team, the method and path, and a stream ID. For your own Mac: your username, the device ID, when the session opened and closed, and the bytes each way. When a team moves between machines: the new machine’s name. These lines hold no IP address and no content.'
        },
        {
          p: 'The load balancer and proxy in front of the registry can record ordinary web logs: IP address, time and the address requested. These logs sit with the hosting platform, not in the registry’s data files, and last as long as that platform keeps them. We use them only to run and protect the service.'
        }
      ]
    },
    {
      id: 'others',
      heading: 'Who else sees your data',
      blocks: [
        {
          ul: [
            'The owner of a team you call. Your session runs on their machine, so they receive your username, your device ID and everything you send, and they can see what their agents do with it. Their agents send it on to whichever AI providers they use. By default the app clears a finished session’s workspace about 30 days after its last write, but it is their machine and we have no control over it. Do not send a team anything you would not give its owner.',
            'Stripe. Card checkout for a seat is hosted by Stripe on the team owner’s own Stripe account, so your card and billing details go to Stripe and the owner, and not to us. Stripe’s privacy policy applies.',
            'Public blockchains. A USDC payment over x402 is recorded on a public chain by its nature.',
            'GitHub. Pictures and videos on these pages load from raw.githubusercontent.com, and app downloads come from GitHub, so GitHub sees your IP address and browser details when that happens. Fonts come from cookrew.dev itself.',
            'Let’s Encrypt and public certificate logs. If your Mac asks for a certificate, its name under d.cookrew.dev, which contains its device ID, goes to Let’s Encrypt and appears in public certificate transparency logs. While your Mac publishes it, a name under d.cookrew.dev also resolves in public DNS to the private network address it spells out.',
            'Our infrastructure providers. The registry is hosted on Amazon Web Services. Cloudflare runs cookrew.dev’s DNS and does not sit in front of site traffic.',
            'Authorities, when the law requires us to disclose what we hold.'
          ]
        },
        { p: 'We do not sell personal data, and we do not share it with advertisers or data brokers.' }
      ]
    },
    {
      id: 'cookies',
      heading: 'Cookies and browser storage',
      blocks: [
        {
          p: 'These keep you signed in, hold your device key, and keep your Mac’s app settings when you open it here. None of them follow you across sites, and pages that have nothing to do run no script at all.'
        },
        {
          table: {
            head: ['Name', 'Kind', 'What it is for'],
            rows: [
              ['__Host-cr_session', `Cookie, HttpOnly, ${days(SESSION_TTL_MS)} days`, 'Keeps you signed in.'],
              ['cr_account', 'Cookie, ends with its token', 'An older sign-in token, still used by accounts from before passwords.'],
              ['Device key', 'IndexedDB', 'A private key that cannot be exported from this browser. It proves this is the same device.'],
              ['cr_token:<device>', 'localStorage', 'The pairing token for a Mac you reach from this browser.'],
              ['Sign-in and checkout markers', 'sessionStorage, ends with the tab', 'Small values for a sign-in or a checkout in progress.'],
              [
                'Your Mac’s app',
                'localStorage, and cookies limited to the relay path',
                'When you open your Mac through the relay, its app runs on this site and keeps its own settings here, such as theme and connection path.'
              ]
            ]
          }
        }
      ]
    },
    {
      id: 'retention',
      heading: 'How long we keep it',
      blocks: [
        {
          table: {
            head: ['Data', 'How long'],
            rows: [
              ['Account, desktops and sign-in factors', 'Until your account is deleted.'],
              ['Devices', 'Until you remove them, or your account is deleted.'],
              ['Sessions', `Each one expires after ${days(SESSION_TTL_MS)} days. The record keeps your last ${SESSIONS_MAX} sessions.`],
              ['IDs of ended sessions and devices', `The last ${REVOKED_MAX} per account, so they stay ended.`],
              [
                'Sign-ins waiting for approval, and join codes',
                `Sign-ins: ${minutes(PENDING_TTL_MS)} minutes. Join codes: ${minutes(JOIN_CODE_TTL_MS)} minutes. Both in memory only.`
              ],
              ['Seat requests and reach requests', `Seat requests: ${days(SEAT_TTL_MS)} days. Reach requests: ${minutes(REACH_TTL_MS)} minutes. Both in memory only, so a restart clears them.`],
              ['Account activity feed', `The last ${EVENTS_KEPT} events per account, in memory only.`],
              ['Rate-limit counters', 'In memory only, and gone at the latest when the registry restarts.'],
              [
                'Seats',
                `Kept after a seat ends, so an owner can see who held it. Ended seats are dropped oldest first once the registry holds ${SEATS_MAX.toLocaleString('en-US')} seats.`
              ],
              ['Team listings', 'Until the owner withdraws them. A listing does not expire on its own.'],
              ['Stars', 'Until you remove them.'],
              ['Private network addresses', `Until your Mac replaces its card or your account is deleted. Public DNS stops answering for a card more than ${hours(DNS_CARD_TTL_MS)} hours old.`],
              ['Certificates', 'Kept for the Mac they belong to, until your account is deleted. Public certificate logs keep theirs permanently.'],
              ['Presets and the transparency log', 'Permanently. There is no unpublish, and the log is append-only by design.'],
              [
                'Preset receipts, payout addresses and quotes',
                `Receipts are kept, so that a purchase stays valid, including after an account is deleted. A payout address is kept until then. A price quote stops counting ${hours(EXPIRED_RETENTION_MS)} hours after it expires, and leaves the file when the file is next cleaned up.`
              ],
              ['Page and call counts', `${PULSE_KEEP_DAYS} days.`],
              ['Setup count daily totals', `${FUNNEL_KEEP_DAYS} days.`],
              ['Last-seen time of a relay line', `Forgotten at the first restart after ${days(SEEN_KEEP_MS)} days without being seen.`],
              ['Server logs', 'As long as the hosting platform keeps them.']
            ]
          }
        }
      ]
    },
    {
      id: 'choices',
      heading: 'Your choices and rights',
      blocks: [
        {
          ul: [
            'See it. Your account page at /me shows your devices, desktops and security settings.',
            'Change it. You can change your display name, avatar, password and sign-in factors.',
            'Remove it. You can take a device off your account, sign out, remove a star and withdraw a team listing.',
            'Turn off the setup counts at any time from the row in the app’s ⋯ menu.',
            `Delete your account. Choose Delete account on your profile in the app, or on your account page at /me if the account has a password. It needs that password, or in the app your sign-in provider if the account has none, and it happens at once. It takes: ${asOneRun(DELETE_ACCOUNT_TAKES)} What stays: ${asOneRun(DELETE_ACCOUNT_KEEPS)}`
          ]
        },
        {
          p: `Depending on where you live, you may have the right to access, correct, delete or export your data, to object to how it is used, and to complain to your local data protection authority. Write to ${CONTACT_EMAIL} and we will respond within the time the law allows.`
        }
      ]
    },
    {
      id: 'security',
      heading: 'How it is protected',
      blocks: [
        {
          p: 'Traffic to cookrew.dev uses TLS. Passwords are stretched with scrypt and recovery codes are hashed, each with its own salt. The session cookie is HttpOnly and cannot be set from a subdomain. A passkey, an authenticator app or approval from another of your devices can each protect a sign-in. No service is perfectly secure, so use a strong, unique password and keep your recovery codes safe: with no email on file, they are how you get back in.'
        }
      ]
    },
    {
      id: 'where',
      heading: 'Where data is held',
      blocks: [{ p: 'The registry runs on Amazon Web Services. Your data may be held in a country other than yours, where privacy law may differ.' }]
    },
    {
      id: 'children',
      heading: 'Children',
      blocks: [
        {
          p: `cookrew.dev is a developer tool and is not meant for children. Do not create an account if you are under 13, or under the minimum age for online services where you live. If you think a child has an account, write to ${CONTACT_EMAIL} and we will remove it.`
        }
      ]
    },
    {
      id: 'planned-sign-in',
      heading: 'Planned: sign in with GitHub or Google',
      planned: true,
      blocks: [
        {
          p: 'Not live. None of this happens today: cookrew.dev has no GitHub or Google sign-in, and the registry holds no data from either. This section says what we intend to do, and becomes an ordinary section when the feature ships.'
        },
        {
          p: 'When it ships, you will be able to use a GitHub or Google account to sign in. We will ask only for your identity with that provider (a stable account ID and your name) and your verified email address. That is a change from today: the registry would then store that identity and email address with your account.'
        },
        {
          p: 'A GitHub sign-in will give us no access to your repositories or code, and a Google sign-in will give us no access to your Gmail, Drive or contacts.'
        },
        {
          p: 'Google user data will be used only for sign-in. It is not sold, not used for advertising, and not used to train AI models. It is not shared with anyone except as needed to run sign-in or as the law requires, and it goes when your account is deleted.'
        },
        {
          p: 'Cookrew’s use and transfer of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.'
        }
      ]
    },
    {
      id: 'planned-credits',
      heading: 'Planned: paid API credits',
      planned: true,
      blocks: [
        { p: 'Not live. None of this happens today: cookrew.dev sells no credits and no hosted model access, and your agents use your own logins.' },
        {
          p: 'We plan to offer prepaid credits for people who have no Claude or Codex account of their own, so the app can call hosted AI models through a gateway we run. If you keep using your own accounts, none of this applies to you.'
        },
        {
          p: 'It will differ from everything above in one important way: your prompts and the models’ replies would pass through that gateway to be answered. Before it launches we will update this section to say exactly what is kept and for how long, who the model providers are and who handles payment. We expect to keep a credit balance and usage records such as model, amount used, cost and time, because billing needs them.'
        }
      ]
    },
    {
      id: 'changes',
      heading: 'Changes to this policy',
      blocks: [
        {
          p: 'When this policy changes we update it here and change the date at the top. We hold no email address to tell you with, so for a significant change we will also say so on cookrew.dev before it takes effect.'
        }
      ]
    },
    { id: 'contact', heading: 'Contact', blocks: [{ p: `${LEGAL_ENTITY}, ${CONTACT_EMAIL}.` }] }
  ]
}

export const TERMS: LegalDoc = {
  title: 'Terms of service',
  lede: 'The rules for using cookrew.dev, its marketplace and its relay.',
  updated: UPDATED,
  sections: [
    {
      id: 'agreement',
      heading: 'Using cookrew.dev',
      blocks: [
        {
          p: `These terms are an agreement between you and ${LEGAL_ENTITY} (“we”) for the website at cookrew.dev, the registry behind it, the marketplace and the relay. By creating an account or using those services you accept them. If you use them for an organisation, you accept them for it too.`
        },
        {
          p: `The Cookrew app is open-source software under the ${FACTS.license} license. You can use it without an account, and that license, not these terms, covers the software. These terms cover the hosted services.`
        },
        { p: 'Our privacy policy at cookrew.dev/privacy explains what we store and what passes through the relay.' }
      ]
    },
    {
      id: 'accounts',
      heading: 'Your account',
      blocks: [
        {
          ul: [
            'You must be at least 13, and old enough to agree to these terms where you live.',
            'Keep your password, devices and recovery codes safe. We hold no email address for you, so if you lose all of them we may not be able to get you back in.',
            'You are responsible for what happens under your account.',
            'Usernames are first come, first served. We may take back a name that impersonates someone, misleads people or infringes a trademark.'
          ]
        }
      ]
    },
    {
      id: 'serving',
      heading: 'Serving a team',
      blocks: [
        {
          p: 'When you serve a team it keeps running on your machine, with your agents and your logins. You are the operator of what you serve. We list it and carry its traffic.'
        },
        {
          ul: [
            'Describe it honestly. Your title, summary, tags and price must be accurate.',
            'Follow the terms of the AI providers and tools your agents use, including any limits on sharing an account or reselling access. Whether serving is allowed under your plan is yours to check.',
            'You receive what callers send you. Use it only to provide their session, take care of it, and follow the privacy law that applies to you.',
            'You are responsible for what your team does, including its output, its tool use and any harm it causes.'
          ]
        }
      ]
    },
    {
      id: 'calling',
      heading: 'Calling a team',
      blocks: [
        {
          p: 'A team you call runs on its owner’s machine, not on ours. We do not review, test or endorse teams in the marketplace. The owner can see what you send, so do not send anything you would not give them. AI output can be wrong, incomplete or unsafe, so check it before you rely on it. A session can end at any time: the owner’s machine can go offline, and the owner can end it.'
        }
      ]
    },
    {
      id: 'payments',
      heading: 'Seats and payments',
      blocks: [
        {
          p: 'An author sets the price of a seat at their team, and the sale is between you and that author. Card payments go through the author’s own Stripe checkout, and USDC payments go over x402 to the author’s address. We are not the seller, we hold no money and we take no cut.'
        },
        {
          ul: [
            'Refunds, chargebacks, tax and disputes over a seat are between buyer and author. Authors are responsible for their own refund terms, invoices and taxes.',
            'A seat is access to one team for as long as it lasts. The author can end it, and it is no promise that the team stays online. It is not a license to the team itself.',
            'Crypto payments cannot be reversed. Check the amount, the chain and the address before you pay.',
            'We keep only a record that the seat exists and a reference to the payment.'
          ]
        }
      ]
    },
    {
      id: 'content',
      heading: 'What you publish',
      blocks: [
        {
          p: 'You keep ownership of what you publish: listings, presets and profile details. You give us a worldwide, royalty-free permission to store, copy, display and distribute it as needed to run the services, and to let others use a published preset.'
        },
        {
          p: 'Published presets and the public log are permanent by design, and there is no unpublish. A limit or a price decides who can download a preset, and anyone who downloads it can pass it on, so never rely on either to keep something secret. Check what you publish, and never publish secrets or anything you do not have the right to share. We may still take content out of public view where the law requires it or these terms are broken.'
        }
      ]
    },
    {
      id: 'rules',
      heading: 'Rules',
      blocks: [
        { p: 'Do not use cookrew.dev, the marketplace or the relay to:' },
        {
          ul: [
            'break the law or anyone’s rights, including intellectual property and privacy rights;',
            'spread malware, phish, steal credentials, or attack or probe systems you are not authorized to test;',
            'send spam, harass people, or distribute illegal content;',
            'get around a limit, a price, a seat or someone’s access controls;',
            'overload or disrupt the hosted services;',
            'hide the origin of abuse, or run the relay as a general-purpose proxy or VPN.'
          ]
        }
      ]
    },
    {
      id: 'service',
      heading: 'The service',
      blocks: [
        {
          p: 'We may change, limit or stop any part of the registry and the relay, and there is no promised uptime. We set limits on traffic, requests and storage to keep the service healthy. Some relay traffic is not end-to-end encrypted, and the privacy policy says which.'
        }
      ]
    },
    {
      id: 'ending',
      heading: 'Suspension and ending',
      blocks: [
        {
          p: 'You can stop at any time: withdraw your listings, sign out your devices and delete your account. We may suspend an account, or remove a listing or preset from public view, if you break these terms, if the law requires it, or to protect people or the service. Where we reasonably can, we will tell you why.'
        }
      ]
    },
    {
      id: 'warranty',
      heading: 'No warranties',
      blocks: [
        {
          p: 'To the extent the law allows, the services are provided “as is” and “as available”, without warranties of any kind, including fitness for a purpose, accuracy and non-infringement. We make no promise about any team, its author or any AI output.'
        }
      ]
    },
    {
      id: 'liability',
      heading: 'Limits on liability',
      blocks: [
        {
          p: 'To the extent the law allows, we are not liable for indirect, incidental, special or consequential losses, or for lost profits, data or goodwill. Our total liability for any claim about the services is limited to the greater of what you paid us in the 12 months before the claim and US$100. Nothing here limits liability that the law does not let us limit, and consumers keep the rights the law gives them.'
        },
        { p: 'If your team, your content or your breach of these terms leads to a claim against us by someone else, you agree to cover our reasonable losses from it.' }
      ]
    },
    {
      id: 'law',
      heading: 'Governing law',
      blocks: [
        { p: `These terms are governed by ${GOVERNING_LAW}. Disputes go to the courts that law points to, unless the law where you live gives you a different right.` }
      ]
    },
    {
      id: 'planned-sign-in',
      heading: 'Planned: sign in with GitHub or Google',
      planned: true,
      blocks: [
        { p: 'Not live. GitHub and Google sign-in do not exist on cookrew.dev yet, and this section does not apply today.' },
        {
          p: 'When it ships, you will be able to use a GitHub or Google account to sign in. Those providers’ own terms will cover your account with them. If you lose access to that account you may lose that way in, so keep another way to sign in.'
        }
      ]
    },
    {
      id: 'planned-credits',
      heading: 'Planned: paid API credits',
      planned: true,
      blocks: [
        { p: 'Not live. We sell no credits today, and this section does not apply.' },
        {
          p: 'We plan to sell prepaid credits for hosted AI models. Full terms, including prices, refunds, expiry, tax, spend limits and which models are offered where, will be published here before anything is sold. Unlike a seat, that sale would not be between you and a team’s author.'
        }
      ]
    },
    {
      id: 'changes',
      heading: 'Changes to these terms',
      blocks: [
        {
          p: 'We may update these terms. We will change the date at the top and, for a significant change, say so on cookrew.dev before it takes effect. If you keep using the services after that, the new terms apply.'
        }
      ]
    },
    { id: 'contact', heading: 'Contact', blocks: [{ p: `${LEGAL_ENTITY}, ${CONTACT_EMAIL}.` }] }
  ]
}
