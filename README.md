# MinitMotort

This project consists of a React/Vite frontend and a Firebase Cloud Functions backend.

## Structure

- `/frontend`: Contains the React frontend application built with Vite, TypeScript, and Tailwind CSS.
- `/backend`: Contains the Firebase backend, including Cloud Functions and configuration.

## Frontend Setup

1. Navigate to the `frontend` directory:
   ```sh
   cd frontend
   ```
2. Install dependencies:
   ```sh
   npm install
   ```
3. Start the development server:
   ```sh
   npm run dev
   ```

## Backend Setup

1. Navigate to the `backend/functions` directory:
   ```sh
   cd backend/functions
   ```
2. Install dependencies:
   ```sh
   npm install
   ```
3. Serve the Firebase functions locally (requires Firebase CLI):
   ```sh
   npm run serve
   ```
   Or deploy to Firebase:
   ```sh
   npm run deploy
   ```

## Technologies Used

### Frontend
- Vite
- React
- TypeScript
- Tailwind CSS
- shadcn/ui

### Backend
- Firebase Cloud Functions
- Node.js
- Express
