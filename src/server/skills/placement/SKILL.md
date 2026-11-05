---
name: placement
description: Where a piece of ServiceNow work should live (the current app, another app, a new custom app, or global) and why. The pdi placement tool applies these rules; load this to explain or discuss them.
modes: decide
---

Where work lives decides what can be installed, upgraded or removed together, who can change it, and what moves to
the next instance. Moving it later is costly, so it's settled before the first change. The pdi placement tool applies the
rules below to what it looks up on the instance (which application owns each table, which app is current) and shows the
user a card; the first rule whose conditions all hold wins.

Each rule: `## id`, then `if:` (conditions, all must hold, `!` negates), `place:` (current-app, owning-app, new-app or
global), `why:` (one line for the card), and optional `warn:` and `cite:`.
Conditions: new-tables, adds-to-current-app (the work is part of the app you're in), table-in-current-app, table-in-other-app, table-in-global, no-tables, current-is-app,
current-is-global, always.

## other-apps-table
if: table-in-other-app
place: owning-app
why: The table belongs to another application, so changes to it belong in that application.
warn: Doing it from a different app needs cross-scope access granted on that table. If that app comes from ServiceNow or the Store, upgrades may skip your changed records; review them after each upgrade.
cite: https://www.servicenow.com/docs/r/application-development/c_ApplicationAccessSettings.html

## extend-current-app
if: table-in-current-app
place: current-app
why: The table belongs to the app you're in, so the change stays with that app.
cite: https://www.servicenow.com/docs/r/application-development/c_ApplicationScope.html

## grow-current-app
if: adds-to-current-app, current-is-app
place: current-app
why: The work grows the app you're in, so it stays with that app.
cite: https://www.servicenow.com/docs/r/application-development/c_ApplicationScope.html

## new-data-model
if: new-tables
place: new-app
why: New tables with their own data, roles and lifecycle belong in their own application, so it can be installed, upgraded or removed on its own.
warn: New custom tables may count toward your custom table entitlement; check your licence.
cite: https://www.servicenow.com/docs/r/platform-administration/allocating-custom-tables-subscr-apps-v2.html

## app-adds-to-global-table
if: table-in-global, current-is-app
place: current-app
why: Your app can add fields and logic to a platform table and keep them with the app, as long as the table allows configuration from other applications.
warn: Check the table's application access settings first; some platform tables don't allow changes from other applications.
cite: https://www.servicenow.com/docs/r/application-development/r_CreationRestrsAcrossAppScopes.html

## global-table
if: table-in-global
place: global
why: The table is a platform table owned by global, and the change is for the whole instance.
warn: Global changes are hard to remove later; name the reason in the update set.
cite: https://www.servicenow.com/docs/r/application-development/c_GlobalScope.html

## no-table-yet
if: no-tables, current-is-global
place: new-app
why: Nothing it touches exists yet, so it can start clean in its own application instead of in global.
cite: https://www.servicenow.com/docs/r/application-development/c_ApplicationScope.html

## default
if: always
place: current-app
why: Nothing points elsewhere, so it stays in the app you're working in.
