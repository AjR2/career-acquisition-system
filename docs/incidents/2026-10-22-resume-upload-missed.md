Observed failure: On the first real application, the resume PDF was not uploaded. Two select answers ("yes", a free-text clearance answer) were not filled.

Expected behavior: The approved PDF is attached; a user answer that matches an option except for capitalization is selected.

Actual behavior: `setInputFiles` hit "Node is not an HTMLInputElement": the "Resume/CV" label on the live Greenhouse form belongs to an Attach button, not the file input. Option matching was exact and case-sensitive. The user was not told: the fill report was stored in the database only. The resume field was optional on form, so the application was **submitted without a resume**. Confirmation was detected correctly.

Root cause: The local fixture form used a plain labeled file input, unlike the live Greenhouse markup. Matching was stricter than needed.

Evidence: `submissions.filled_json` for posting 1706 (leftForUser entries); user submission succeeded with confirmation evidence.

Correction: (1) Resume upload targets a real `input[type=file]` (resume-named first, then the first file input) instead of the label's element. Option matching tries exact, then case-insensitive whole-text equality (never partial). (2) A banner on the employer form lists everything CAS did not fill, with RESUME NOT ATTACHED and the PDF path when the upload fails (display only; no field touched). (3) The item page shows the fill report. (4) The weekly report lists submissions without a CAS-attached resume. (5) Tests write PDFs to a temp directory (a test had written one into data/materials).

Preventive control: The fixture form now mirrors Greenhouse (label on an Attach button, separate file input) and the test asserts the file is attached.

Regression test: `tests/integration/apply.test.ts` ("fills approved fields ... records SUBMITTED only after confirmation").

Impact: application (posting 1706) has no resume. Follow-up is the user's decision.

Remaining risks: Other employers' Greenhouse customizations. Misses are now visible on the form before submit, but the user can still submit past the banner.
