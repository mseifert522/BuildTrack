# BuildTrack — New Urban Development Field Operations Platform

> A full-stack construction project management application with a **mobile-first** design, real-time collaboration, punch lists, invoicing with PDF delivery, and progress photo tracking.

---

## Table of Contents

1. [Overview](#overview)
2. [Tech Stack](#tech-stack)
3. [Project Structure](#project-structure)
4. [Quick Start (Local Development)](#quick-start-local-development)
5. [Database Setup](#database-setup)
6. [Self-Hosting on a VM Server](#self-hosting-on-a-vm-server)
7. [Environment Variables](#environment-variables)
8. [User Roles](#user-roles)
9. [Features](#features)
10. [API Reference](#api-reference)

---

## Overview

BuildTrack is a field operations platform built for **New Urban Development**. It provides:

- A **mobile-optimized** interface for contractors and field staff (Projects, Punch Lists, Invoices)
- A **professional enterprise desktop dashboard** for Admins and Operations Managers
- **Real-time collaboration** via Server-Sent Events (SSE) for notes and punch list updates
- **PDF invoice generation** with automatic email delivery to the office and contractor
- **Progress photo timeline** organized per project with date/time stamps
- **Google Places Autocomplete** on all address fields
- **Project lifecycle tracking**: Acquired → Pre-Construction → Under Construction → Completed → Sold/Disposed

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite, TailwindCSS, React Router v6 |
| Backend | Node.js, Express 5, better-sqlite3 |
| Database | SQLite (single file, zero-config, easy to migrate) |
| Auth | JWT (JSON Web Tokens) with bcryptjs password hashing |
| Real-time | Server-Sent Events (SSE) |
| PDF | PDFKit |
| Email | Nodemailer (SMTP) |
| File Uploads | Multer (stored in `backend/uploads/`) |
| Process Manager | PM2 (production) |

---

## Project Structure

```
BuildTrack/
├── frontend/                  # React + Vite frontend
│   ├── src/
│   │   ├── pages/             # All page components (Desktop + Mobile)
│   │   ├── components/        # Reusable components (Layout, GooglePlacesInput, etc.)
│   │   ├── store/             # Zustand auth store
│   │   ├── lib/               # Axios API client
│   │   └── index.css          # Global styles + mobile-lock CSS
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json
│
├── backend/                   # Express API server
│   ├── src/
│   │   ├── routes/            # API route handlers
│   │   │   ├── auth.js        # Login, register, JWT
│   │   │   ├── projects.js    # Projects CRUD + lifecycle stats
│   │   │   ├── punchList.js   # Punch list items CRUD
│   │   │   ├── photos.js      # Photo upload + progress photos
│   │   │   ├── invoices.js    # Invoice CRUD + PDF + email submit
│   │   │   ├── notes.js       # Real-time project notes (SSE)
│   │   │   └── users.js       # User management
│   │   ├── db/
│   │   │   ├── schema.js      # SQLite table definitions (auto-run on startup)
│   │   │   └── seed.js        # Initial seed data (users, sample project)
│   │   └── utils/
│   │       ├── pdf.js         # PDFKit invoice generator
│   │       └── email.js       # Nodemailer email sender
│   ├── data/                  # SQLite database files (git-ignored)
│   ├── uploads/               # Uploaded photos (git-ignored)
│   ├── server.js              # Express app entry point
│   ├── .env.example           # Environment variable template
│   └── package.json
│
├── .gitignore
└── README.md                  # This file
```

---

## Quick Start (Local Development)

### Prerequisites

- **Node.js** v18 or higher
- **npm** v9 or higher

### 1. Clone the repository

```bash
git clone https://github.com/mseifert522/BuildTrack.git
cd BuildTrack
```

### 2. Set up the backend

```bash
cd backend
cp .env.example .env
# Edit .env with your values (JWT secret, SMTP credentials, etc.)
npm install
```

### 3. Initialize the database

The database is created automatically on first run. To seed initial users and sample data:

```bash
node src/db/seed.js
```

This creates:
- Super Admin: `mike@seifertcapital.com` / `test123456789`
- Ops Manager: `heather@seifertcapital.com` / `test123456789`
- Contractor: `contractor@newurbandev.com` / `test123456789`

### 4. Start the backend

```bash
node server.js
# Backend runs on http://localhost:3001
```

### 5. Set up the frontend

```bash
cd ../frontend
npm install
npm run dev
# Frontend runs on http://localhost:5173
```

Open http://localhost:5173 in your browser.

---

## Database Setup

BuildTrack uses **SQLite** — a single file database that requires zero server setup.

### Database file location

```
backend/data/buildtrack.db
```

### Schema auto-migration

The schema is defined in `backend/src/db/schema.js` and runs automatically every time the server starts. It uses `CREATE TABLE IF NOT EXISTS` so it is safe to run repeatedly without data loss.

### Tables

| Table | Description |
|---|---|
| `users` | All users with roles, hashed passwords, email |
| `projects` | Projects with address, lifecycle status, occupancy, dates |
| `punch_list_items` | Punch list items per project with status, priority, assignee |
| `photos` | Photos linked to projects or punch list items, with type and timestamp |
| `invoices` | Invoices with line items (JSON), totals, status, linked project |
| `project_notes` | Real-time notes per project with author and timestamp |

### Manual database inspection

```bash
cd backend
node -e "
const Database = require('better-sqlite3');
const db = new Database('./data/buildtrack.db');
console.log(db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all());
"
```

### Backup the database

```bash
cp backend/data/buildtrack.db backend/data/buildtrack_backup_$(date +%Y%m%d).db
```

---

## Self-Hosting on a VM Server

These instructions apply to any Ubuntu 20.04+ or Debian 11+ VM (DigitalOcean, Linode, AWS EC2, Hetzner, your own hardware, etc.).

### Step 1 — Provision the VM

Minimum recommended specs:
- **CPU**: 1 vCPU
- **RAM**: 1 GB
- **Disk**: 20 GB SSD
- **OS**: Ubuntu 22.04 LTS

### Step 2 — Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # should be v20.x
```

### Step 3 — Install PM2

```bash
sudo npm install -g pm2
```

### Step 4 — Clone the repository

```bash
cd /opt
sudo git clone https://github.com/mseifert522/BuildTrack.git
sudo chown -R $USER:$USER /opt/BuildTrack
cd /opt/BuildTrack
```

### Step 5 — Configure environment

```bash
cd /opt/BuildTrack/backend
cp .env.example .env
nano .env   # Fill in JWT_SECRET, SMTP credentials, etc.
```

**Important**: Set a strong `JWT_SECRET` (at least 32 random characters).

### Step 6 — Install dependencies

```bash
# Backend
cd /opt/BuildTrack/backend
npm install

# Frontend — build production bundle
cd /opt/BuildTrack/frontend
npm install
npm run build
```

### Step 7 — Initialize the database

```bash
cd /opt/BuildTrack/backend
mkdir -p data uploads
node src/db/seed.js
```

### Step 8 — Start with PM2

```bash
cd /opt/BuildTrack/backend
pm2 start server.js --name buildtrack
pm2 save
pm2 startup   # Follow the printed command to enable auto-start on reboot
```

The app will now be running on **http://your-server-ip:3001**

### Step 9 — Set up Nginx reverse proxy (recommended)

```bash
sudo apt install -y nginx
sudo nano /etc/nginx/sites-available/buildtrack
```

Paste the following (replace `yourdomain.com` with your actual domain or IP):

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    client_max_body_size 50M;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
        # Required for SSE (real-time notes)
        proxy_buffering off;
        proxy_read_timeout 86400s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/buildtrack /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Step 10 — Enable HTTPS with Let's Encrypt (optional but recommended)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

### Step 11 — Firewall

```bash
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

### Updating the app

```bash
cd /opt/BuildTrack
git pull origin main
cd frontend && npm install && npm run build
cd ../backend && npm install
pm2 restart buildtrack
```

---

## Environment Variables

See `backend/.env.example` for the full list. Key variables:

| Variable | Required | Description |
|---|---|---|
| `PORT` | Yes | Port the server listens on (default: 3001) |
| `JWT_SECRET` | Yes | Secret key for signing JWT tokens — keep this private |
| `DB_PATH` | Yes | Path to SQLite database file |
| `SMTP_HOST` | For email | SMTP server hostname |
| `SMTP_USER` | For email | SMTP username / email address |
| `SMTP_PASS` | For email | SMTP password or app password |
| `OFFICE_EMAIL` | For email | Office email that receives invoice copies |
| `VITE_GOOGLE_MAPS_API_KEY` | For autocomplete | Google Maps / Places API key |

---

## User Roles

| Role | Key | Permissions |
|---|---|---|
| Super Admin | `super_admin` | Full access — all features, user management, all projects |
| Operations Manager | `ops_manager` | Create/edit projects, manage punch lists, view all invoices |
| Contractor | `contractor` | View projects, add punch list items, create/submit invoices |

---

## Features

### Mobile App
- Device-aware routing — phones/tablets automatically go to the mobile interface
- **Projects** — view all projects, tap to open project hub
- **Punch Lists** — add items with voice input or typing, attach photos from camera, see inline photo thumbnails
- **Invoices** — create invoices with voice input per line item, live running total, save as draft or submit to office
- **Progress Photos** — chronological construction photo timeline with date/time stamps per project
- **Notes** — real-time collaborative notes per project (SSE-powered)
- Locked viewport — no bounce, no sideways scroll, native app feel on iOS and Android

### Desktop Dashboard
- Enterprise sidebar navigation with collapsible menu
- **4 KPI cards**: Total Acquisitions, Under Construction, Completed Projects, Dispositions/Sold
- Project pipeline table with lifecycle status and occupancy alerts
- Recent invoices panel
- Full project management with lifecycle tracking

### Project Lifecycle
- Statuses: `Acquired` → `Pre-Construction` → `Under Construction` → `Completed` → `Sold / Disposed`
- Occupancy flag with estimated construction start date (calendar picker)
- Acquisition date, construction start date, sold date tracking

---

## API Reference

All API routes are prefixed with `/api`.

| Method | Route | Description |
|---|---|---|
| POST | `/api/auth/login` | Login, returns JWT token |
| GET | `/api/projects` | List all projects |
| POST | `/api/projects` | Create a new project |
| GET | `/api/projects/stats` | Lifecycle KPI counts |
| PUT | `/api/projects/:id` | Update project |
| GET | `/api/projects/:id/punch-list` | Get punch list items |
| POST | `/api/projects/:id/punch-list` | Add punch list item |
| GET | `/api/projects/:id/photos` | Get project photos |
| POST | `/api/projects/:id/photos` | Upload photos |
| GET | `/api/projects/:id/invoices` | Get invoices for project |
| POST | `/api/projects/:id/invoices` | Create invoice |
| POST | `/api/invoices/:id/submit` | Submit invoice (sends PDF email) |
| GET | `/api/projects/:id/notes` | Get project notes |
| POST | `/api/projects/:id/notes` | Add a note |
| GET | `/api/projects/:id/notes/stream` | SSE stream for real-time notes |
| GET | `/api/users` | List users (admin only) |

---

## License

Proprietary — New Urban Development. All rights reserved.
