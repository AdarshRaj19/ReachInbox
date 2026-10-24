# ReachInbox --- Email Scheduling and Sending

ReachInbox is a full-stack email scheduling application. It lets a
signed-in user prepare an email campaign, upload a list of recipients,
choose when emails should be sent, and track scheduled and sent emails.
The backend uses a queue so scheduled emails can wait until their send
time instead of relying on a cron job.

This README describes the features implemented and tested during
development, how the main parts fit together, and how to run the project
locally. Some setup values depend on your own `.env` file and service
accounts, so keep your local credentials private.

## What the application does

-   Signs users in through Google OAuth.
-   Lets users compose an email with a subject and body.
-   Accepts recipient lists from CSV and TXT files and displays the
    parsed recipient count.
-   Schedules emails for a chosen start time.
-   Supports a delay between individual email sends.
-   Applies a configurable hourly sending limit.
-   Shows scheduled emails and sent emails in separate dashboard tabs.
-   Sends emails through the configured SMTP provider. Ethereal was used
    during development for testing.
-   Stores application data in PostgreSQL.
-   Uses BullMQ and Redis to queue and delay jobs.
-   Indexes email information in Elasticsearch for search.
-   Provides a Bull Board dashboard for inspecting queue jobs.
-   Sends a Slack notification when the hourly sending limit is reached.
-   Recovers queued work when the backend/worker starts again.

## Technology used

### Frontend

-   React-based frontend
-   TypeScript
-   Dashboard UI for composing and viewing emails
-   CSV/TXT recipient-list parsing
-   Loading, empty, and error states

### Backend and services

-   Node.js
-   Express
-   TypeScript
-   BullMQ for background jobs and delayed scheduling
-   Redis for queue storage and coordination
-   PostgreSQL for persistent application data
-   Nodemailer with Ethereal SMTP for development email testing
-   Elasticsearch for email indexing and search
-   Slack API for hourly-limit alerts
-   Google OAuth for user sign-in
-   Bull Board for queue monitoring

## How it works

1.  **Sign in:** The user signs in with Google.
2.  **Prepare a campaign:** The user enters the email subject and body
    and supplies recipients by uploading a CSV or TXT file.
3.  **Choose the schedule:** The user selects a start time and the delay
    between sends. The configured hourly limit is also applied.
4.  **Save and queue:** Campaign and email information is saved in
    PostgreSQL, while BullMQ and Redis manage queued and delayed work.
5.  **Process the queue:** The worker picks up jobs when they become
    eligible and sends the email through the configured SMTP transport.
6.  **Update and search:** Email status is stored so the dashboard can
    show scheduled and sent messages. Email information is indexed in
    Elasticsearch for searching.
7.  **Handle the hourly limit:** When the hourly limit is reached, the
    worker delays the affected job until the next eligible hour instead
    of intentionally dropping it. A Slack alert is sent, with
    Redis-based protection to avoid repeatedly sending the same alert
    for the same campaign and hour window.
8.  **Recover after restart:** The queue and its delayed-job data are
    held in Redis, and startup recovery logic helps the worker resume
    pending work after a restart.

## Queue settings

The backend has these configurable settings, with the defaults used
during development:

  --------------------------------------------------------------------------
  Setting                                      Default Purpose
  ----------------------- ---------------------------- ---------------------
  `MAX_EMAILS_PER_HOUR`                          `200` Maximum sends allowed
                                                       in an hour window

  `WORKER_CONCURRENCY`                             `5` Number of jobs the
                                                       worker can process
                                                       concurrently

  `MIN_DELAY_MS`                                `2000` Minimum spacing
                                                       between sends, in
                                                       milliseconds
  --------------------------------------------------------------------------

The application uses Redis to coordinate the hourly send count and
minimum spacing. The worker moves a job to a later time when the hourly
cap prevents it from being sent immediately.

> Use the exact variable names and any additional required variables
> from your local backend configuration. Do not commit your `.env` file
> or put OAuth secrets, database passwords, SMTP credentials, Slack
> tokens, or other private keys in this README.

## Restart recovery and duplicate-send testing

During testing, a scheduled email was created for a future time. The
backend and worker were stopped before the send time and then restarted.
The scheduled email was checked after its scheduled time to confirm that
it resumed processing and was delivered without a duplicate in that
test.

This is a practical recovery test, not a claim that SMTP can guarantee
exactly-once delivery in every possible crash scenario. If a mail server
accepts a message just before a worker crashes, the application may not
always be able to determine whether delivery happened. Queue persistence
and job-state handling reduce the risk, but external SMTP delivery has
this limitation.

## Slack hourly-limit alerts

Slack OAuth was connected and the Slack connection was stored in
PostgreSQL. The hourly-limit notification helper was separated into its
own module to keep the worker logic easier to maintain.

The helper: - Looks up the campaign owner and Slack connection. - Uses a
Redis key with an expiry to prevent duplicate alerts for the same
campaign and hour window. - Posts a notification to the configured Slack
channel. - Releases the alert claim if the Slack request fails, allowing
a later retry. - Logs errors rather than silently treating a failed
Slack notification as successful.

A controlled test of the notification helper successfully posted a
message to the configured ReachInbox Slack channel. The Redis
duplicate-alert claim was also tested: the first claim succeeded and a
second claim was blocked.

## Queue monitoring and email search

-   **Bull Board** is included to inspect queue jobs and their state.
-   **Elasticsearch** is used to index email information and support
    search.
-   **PostgreSQL** remains the persistent store for application records
    and connected account information.
-   **Redis** is used for BullMQ's queue data and coordination keys for
    scheduling limits and Slack alert deduplication.

The exact dashboard and API URLs depend on the routes configured in the
current source code.

## Local setup

### Prerequisites

Install or have access to: - Node.js and npm - PostgreSQL - Redis -
Elasticsearch - A Google OAuth application - An SMTP test account such
as Ethereal - A Slack app/bot configured for the required OAuth and
message permissions

### 1. Get the code

Clone your repository, then open the backend folder. For the development
setup used during this project, the backend was run from:

``` powershell
cd C:\Users\ADMIN\Desktop\ReachInbox\backend
```

If you clone the project somewhere else, use that location instead.

### 2. Install backend dependencies

``` powershell
npm install
```

### 3. Configure environment variables

Create a local `.env` file using the variable names expected by the
source code. Configure the database connection, Redis, Elasticsearch,
Google OAuth, SMTP/Ethereal, and Slack credentials as needed.

Do not copy real secrets into the repository. Keep `.env` out of Git and
provide reviewers with safe setup instructions instead.

### 4. Start required services

Make sure PostgreSQL, Redis, and Elasticsearch are running and reachable
using the values in your local configuration.

### 5. Start the backend

The backend package includes this development command:

``` powershell
npm run dev
```

This runs the TypeScript entry point in watch mode. If your current
setup runs the worker as a separate process, start it using the worker
command defined in your package scripts. Avoid starting duplicate worker
processes unintentionally.

### 6. Check TypeScript

Run:

``` powershell
npm run typecheck
```

The type-check command completed successfully during development after
the Slack alert helper was integrated.

### 7. Start the frontend

Open a separate terminal, go to the frontend directory, install its
dependencies if necessary, and run the development command defined in
that frontend's `package.json`.

The frontend's exact start command and API base URL should be taken from
the current frontend package/configuration rather than guessed.

## Testing completed during development

The following checks were performed during development:

-   Backend TypeScript type-check completed successfully.
-   Email scheduling and worker processing were tested using the
    configured Ethereal SMTP setup.
-   Email status updates were checked after processing.
-   Elasticsearch indexing/search integration was tested.
-   The Slack hourly-limit alert helper successfully sent a test
    notification.
-   Redis duplicate-alert protection was tested; a second claim for the
    same alert key was blocked.
-   A scheduled email was tested across a backend/worker restart and was
    confirmed to resume and send without a duplicate in that test.
-   Google login was confirmed to work by signing in through Google.

These checks reflect the development tests performed; they are not a
substitute for testing the project again in a fresh environment.

## Project structure

The backend files discussed during development include:

``` text
backend/
├── src/
│   ├── index.ts
│   ├── email-queue.ts
│   ├── email-worker.ts
│   └── slack-hourly-alert.ts
├── package.json
└── .env                
```

Other frontend, database, OAuth, Elasticsearch, and queue-dashboard
files may be present in the repository. Keep this tree aligned with the
actual committed source before submission.






