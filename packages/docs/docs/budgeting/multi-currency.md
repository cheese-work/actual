# Multi-Currency

Actual keeps one budget in one **Main currency**. Accounts can hold another currency, and reports and the sidebar show those balances as an **estimate in the Main currency**. Nothing you enter is converted or rewritten: every transaction and balance stays stored in its own account's currency.

## Main currency

1. Open _Settings → Currency_ and choose a **Default Currency**. This is your Main currency, and there is only one.
2. For each account in another currency, set the account's currency when you create or edit it.

The Main currency, exchange rates and custom units are synced preferences. Every device that opens the budget sees the same values after it syncs.

## Exchange rates

Under _Settings → Currency → Exchange rates_, choose for each foreign currency:

- **Manual**: you type the rate (1 unit of the foreign currency = _N_ Main currency). You can edit or remove it at any time. A manual rate in either direction is used, and it always wins over an automatic rate.
- **Automatic**: Actual refreshes a cached rate about once a day, and you can refresh it on demand. Reports and the sidebar read the cached rate. They never fetch a rate while drawing, and an older cached rate stays in use until the next refresh succeeds.

Changing or removing a rate refreshes the visible totals right away. Rates are never chained through a third currency.

### Custom units

You can define your own unit (for example reward points) with a code that starts with `X-`, a name, a symbol and 0 to 2 display decimals. Custom units always use manual rates.

## What the numbers mean

- **Current-rate estimate.** A converted value is the amount at the rate in effect now, applied to the whole date range of the report. Actual does not keep historical rates, so a past month is not what that money was worth then. Reports say so in a note.
- **Missing rate.** If a foreign account has no usable rate, its row shows `no rate` and a total that needs it shows as unavailable. Actual does not show a partial total or add amounts of different currencies together.
- **Rounding.** Each converted balance is rounded once. When fewer decimals make a subtotal differ from its rows by a cent, a separate **Rounding adjustment** line shows the difference.
- **Off-budget foreign accounts.** Foreign-currency accounts are tracked off budget. They appear in the sidebar and in reports that include off-budget accounts, and they do not feed budget categories.
- **Budget math is unchanged.** Category budgets, balances and carryover are computed from the Main currency amounts you enter. Conversion is display-only.
- **Formulas.** Formula results are not converted. A formula that combines foreign-currency account amounts is unsupported and may mix currencies.

## Not supported

- Cryptocurrency accounts and rates.
- Arbitrary rate formulas. A rate is a plain positive decimal.
- A separate display or budget currency per report.
- Historical exchange rates.

:::note
The Vietnamese translation is hidden from _Settings → Language_ by default. The browser and Electron packaging scripts and the CI setup step copy `locale-fork/vi.json` into the build only through `bin/stage-vietnamese.mts`. That script stages it only when `packages/desktop-client/locale-fork/batches.json` declares a current screen batch and the batch gate (`bin/check-vietnamese-batch.mts`, run as `yarn check:i18n`) finds that batch complete. What it writes to `locale/vi.json` is a filtered file, not a copy of the fork catalogue: only the validated declared `keys` and `sharedKeys` (plural groups expanded to the Vietnamese plural forms the gate checked), in source order. Translations outside the batch are never staged, even if they are present in `locale-fork/vi.json`, partial or malformed. The manifest is `{ "version": 1, "current": null | { "name", "keys", "sharedKeys" } }`; `keys` are the exact English strings of the screens in the batch (plural groups by base key) and `sharedKeys` are strings shared with other screens that the batch also needs. A batch is complete when every one of those strings (every Vietnamese plural form included) exists in the current English extraction, has a non-empty translation, and keeps its `{{placeholders}}` and `<Trans>` tags. English strings outside the batch are ignored. A malformed manifest, an unknown or duplicate key, or any gap inside the batch fails the gate.

No screen batch is declared at this revision (`"current": null`), so Vietnamese is withheld: nothing is staged, a stale `locale/vi.json` is removed, and `yarn check:i18n` passes with a message saying no batch is declared. A failed gate, an invalid manifest or a missing key inside the batch likewise stages nothing and removes any stale file. Choosing a batch and accepting its translation are separate decisions made in a reviewed change to `batches.json`; a passing gate is a technical check only. A required CI job (`.github/workflows/vietnamese-coverage.yml`) runs `yarn check:i18n` and fails on an invalid manifest or an incomplete declared batch, while packaging only withholds. `yarn check:i18n --catalogue` prints the whole-catalogue count for information only and is never the enable signal. `bin/package-electron --skip-translations` stages no Vietnamese and forwards the flag to its nested browser build.
:::

## Legacy method: converting transactions with rule templates

This older workaround is not needed for the Main currency view above. It **rewrites the stored amount** of each converted transaction into your budget currency, so use it only if you want the converted amount recorded in the transaction itself.

:::warning
This uses an _experimental feature_, so we're still working on finishing it. There may be bugs, missing functionality, or incomplete documentation, and we may decide to remove the feature in a future release. If you have any feedback, please [open an issue](https://github.com/actualbudget/actual/issues) or post a message in Discord.
:::

## Setup

1. Enable Rule Action Templating
   - In the sidebar, click on the _Settings->Show advanced settings->Experimental features_.
   - Click _I understand the risks, show experimental features_.
   - Click _Rule action templating_.

2. Create Foreign Currency Account
   - As an optional step, you can create a new account for the foreign currency, either:
     - Add a note to the account `#currency:XXX` where XXX is the 3-letter currency code as defined by [ISO 4217](https://en.wikipedia.org/wiki/ISO_4217) (i.e., EUR, USD, AUD, etc).
     - Name the account with the currency code in parens (i.e., `Australian Cash (AUD)`).

     ![Account Name and Notes](/img/multi-currency/account-name-and-note.webp)

     Neither is required, but naming the account this way or creating a note will allow a smooth transition when multi-currency is enabled.

3. Create Rules

   You will need to create two separate rules for each foreign currency account.

   **Rule 1:**

   ![Rule 1](/img/multi-currency/rule-1.webp)
   - From the Rules page, click on the _Create new rule_ button in the bottom right.
   - In the Rule Modal edit popup.
   - In _Stage of rule_ select **Post**.
   - _Conditions_ must be set to **if `All` of these conditions match**.
     - `Account` **is**, and select the foreign currency account.
     - `notes` **is not** set to _nothing_.
     - `notes` **does not contain** _FX rate:_
   - Under _Then apply these actions:_
     - Click the Template toggle button on the left side of the action, just to the right of the -/+ symbols. The action must be of type _set notes_ or _set amount_ before the Template toggle button appears.

     ![Rule Action Template mode not available](/img/multi-currency/rule-action.webp)

     ![Rule Action Normal Mode](/img/multi-currency/rule-action-normal-instructions.webp)

     ![Rule Action Template Mode](/img/multi-currency/rule-action-template.webp)
     - _set notes_ with this content: **`{{ fixed (div amount 100) 2 }}` XXX (FX rate: FX_RATE) • `{{ notes }}`**, where XXX is the currency code.
       - FX_RATE is the exchange rate (i.e., insert 0.65 for 1 AUD = 0.65 USD).
     - Click the + symbol to add a new action line.
     - Click the Template toggle button for this line.
     - _set amount_ to: **`{{ fixed (mul amount FX_RATE) 0 }}`**.
       - FX_RATE is the same as above.

   - Click on the _Save_ button.

   **Rule 2:**

   ![Rule 2](/img/multi-currency/rule-2.webp)
   - From the Rules page, click on the _Create new rule_ button in the bottom right.
   - In the Rule Modal edit popup.
   - In _Stage of rule_ select **Post**.
   - _Conditions_ must be set to **if `All` of these conditions match**.
     - `Account` **is**, and select the foreign currency account.
     - `notes` **is** set to _nothing_.
   - Under _Then apply these actions:_
     - Click the Template toggle button on the left side of the action, just to the right of the -/+ symbols.
     - _set notes_ with this content: **`{{ fixed (div amount 100) 2 }}` XXX (FX rate: FX_RATE)**, where XXX is the same currency code from the first rule.
       - FX_RATE is the exchange rate from the first rule.
     - Click the + symbol to add a new action line.
     - Click the Template toggle button for this line.
     - _set amount_ to: **`{{ fixed (mul amount FX_RATE) 0 }}`**.
       - FX_RATE is the same as above.
   - Click on the _Save_ button.

## Usage

1. Create a transaction in the foreign currency account using the foreign currency amount. (i.e., if the normal budget currency is USD but the account is AUD, then enter the AUD amount in the Payment or Deposit column).

   ![Pre-Conversion Transaction](/img/multi-currency/usage-preconvert.webp)

2. Go to the Rules page and select one of the two rules for that account. At the bottom will be transactions to which the rule can be applied.
   - If you do not see the transaction(s) that you want to convert, click cancel and check the other rule for that account.
   - Select the transaction(s) that you would like to convert and click the _Apply actions_ button.
   - Once the actions have been applied, click cancel since you don't want to change the rule.

![Apply Exchange Rate to Transaction](/img/multi-currency/usage-convert.webp)

3. Return to the foreign currency account to verify that the transaction was converted.

   ![Post-Conversion Transaction](/img/multi-currency/usage-postconvert.webp)
