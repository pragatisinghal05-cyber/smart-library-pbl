# Smart Library - Web version

Run (from the project folder, needs only Node.js 16+, no npm install):

    node web/server.js
    # open http://localhost:3000

It reads and writes the same `data/*.txt` files as the C/C++ console program, so both stay in sync.

## Login security
- Only one Secure ID can log in (set in `OWNER_ID` in `server.js`), and only one session at a time.
- Before the first run set `INITIAL_PASSWORD` in `server.js`. The server stores only a salted scrypt hash in `data/auth.json` and prints a one-time RECOVERY KEY - write it down.
- Forgot password: Secure ID + recovery key -> new password (a new recovery key is issued, old one stops working).
- 5 wrong attempts lock that address for 15 minutes; sessions expire after 15 idle minutes.

## Admin features
- **Dashboard**: totals, most popular books, stock by genre, last-7-days activity, top borrowers, overdue list, recent activity.
- **Books**: search / filter / sort, who currently holds each book, times issued; click a book for its full issue history, edit title/author/genre, delete.
- **Stock**: available vs issued per genre, books currently out, books never issued.
- **Issue log**: every issue and return (student, book, issued, due, returned, fine) with filters and CSV export.
- **Students**: lookup by student ID, books issued now, past borrowing, overdue and fines, recommendations; create, reset password, delete.
- **Issue / Return desk**: issue a book to a student or mark a loan returned.
- **Settings**: loan period and fine per day, CSV export, change password.

## Student features
Browse and search books, issue, return, my issued books (with due date and fines), history, recommendations, change password.

## Extra files created by the web app (the C program ignores them)
- `data/issue_dates.txt`  - issue and return dates
- `data/web_settings.json` - loan period and fine per day

Books issued before the web app existed (or through the console program) show "Not recorded" for dates and have no fine.
Each book is a single copy (same as the C program), so "stock" means available vs issued.
