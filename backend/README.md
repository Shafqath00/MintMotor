# MinitMotort Backend

This directory contains the backend for the MinitMotort application, built with Firebase Cloud Functions and Node.js.

## Prerequisites

- Node.js (v22 or later recommended)
- Firebase CLI (`npm install -g firebase-tools`)

## Project Structure

- `firebase.json`: Firebase configuration file specifying hosting and function deployment settings.
- `.firebaserc`: Firebase project aliases.
- `functions/`: Directory containing the backend source code.

## Local Development

To run the backend locally using the Firebase emulator:

1. Navigate to the `functions` directory:
   ```sh
   cd functions
   ```

2. Install dependencies:
   ```sh
   npm install
   ```

3. Start the Firebase emulator:
   ```sh
   npm run serve
   ```

## Deployment

To deploy the backend to Firebase:

1. Make sure you are authenticated with Firebase:
   ```sh
   firebase login
   ```

2. Navigate to the `functions` directory (if not already there):
   ```sh
   cd functions
   ```

3. Deploy the functions:
   ```sh
   npm run deploy
   ```
