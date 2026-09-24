# GHA++ Privacy Policy

Last updated: September 23, 2026

GHA++ is an independently developed browser extension that improves GitHub
Actions job-log viewing. It is not affiliated with or endorsed by GitHub.

## Information the extension handles

GHA++ processes GitHub page URLs and page content to detect Actions jobs and
display their logs. This includes repository, workflow, job, and step identifiers,
names, statuses, timestamps, and log contents. These may include personal or
confidential information present in your repositories or workflow output.

For live updates, GHA++ observes GitHub's SharedWorker connection and messages,
uses GitHub-provided signed subscription tokens and socket-session URLs, and
subscribes to Actions events. Account identifiers may be present in connection
information and subscription metadata. The bridge does not attach a listener to
GitHub's own port to inspect unrelated incoming messages.
Authenticated requests use your existing GitHub session; GHA++ does not ask you
to enter your GitHub password or a personal access token.

The extension handles viewer interactions such as opening log groups and using
the follow control to operate the interface. It does not record general keyboard
input or maintain a browser-wide browsing history.

## Where information goes

Log parsing and rendering take place in your browser. GHA++ does not operate a
developer-owned server that receives your logs, credentials, or browsing activity,
and it includes no advertising or analytics service.

To retrieve logs and updates, your browser communicates directly with GitHub,
including its live socket service, and GitHub's Azure Blob Storage log hosts.
These requests include the resource identifiers and authentication information
needed by those services. Connections use HTTPS or WSS. Those services receive
ordinary connection information, such as your IP address, and their own privacy
policies apply to their handling of requests.

The enable/disable preference is stored through Chrome's storage sync API. Chrome
may sync this preference through your Google account according to your browser
settings. GHA++ does not put log contents or GitHub credentials into Chrome
extension storage.

## Retention and controls

Fetched logs and live data are held in memory for the viewer. GHA++ does not create
a persistent log database or write log payloads and session tokens to the console.
Closing the page releases its active viewer state; browser caching is controlled
by the browser.
The enable/disable preference persists in Chrome storage until changed or cleared.

The live bridge is loaded on GitHub pages, including pages outside Actions. In the
current version, the in-extension disable switch turns off the replacement viewer,
but does not stop this bridge. To stop all extension
activity, disable or remove GHA++ in Chrome's extension manager and reload or close
existing GitHub tabs.

## Use and sharing restrictions

GHA++'s use of user data adheres to the Chrome Web Store User Data Policy, including
the Limited Use requirements. User data is used to provide and troubleshoot the
GitHub Actions viewer, not for advertising, profiling, sale, creditworthiness, or
lending decisions. Data is not sold or transferred to data brokers. The service
communications and Chrome preference sync described above support the extension's
functionality; there is no automatic transfer of user data to the developer.

If you choose to send a bug report to the developer, the content
you send will be available to its recipients. GitHub issues are public: do not
include secrets, private repository logs, or other confidential data in them.

## Questions and updates

For privacy questions, contact the maintainer through the
[GHA++ project](https://github.com/mikekap/ghaplusplus). This policy will be updated
when the extension's data practices change, with the update date shown above.
