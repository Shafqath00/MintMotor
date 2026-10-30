# Private seller media

Seller uploads use `private-sellers/{ownerId}/cars/{carId}/{file}`. Storage rules
check the server-maintained `storageSellerListings/{carId}` mirror in the default
Firestore database, because Storage rules cannot read the named `mintmotor`
database. Backfill the mirror before deploying these rules, including public
dealer inventory whose older objects use the `users` prefix.

The API delivers image bytes at `GET /cars/{id}/images/{index}` with
`Cache-Control: private, no-store`. Owners can view their own listing, active
verified approved dealers can view published private dealer-network-free
listings, and existing public adverts use the shared marketplace expiry policy.
No subscription is required for dealer access to private submissions.

Call `scrubPrivateImageTokens` before accepting uploaded paths into a listing.
Firebase automatically attaches download tokens when uploading; these bypass
Storage read rules until revoked. The helper reads metadata back and fails
closed if a token remains.

Legacy migration is two-phase: `prepareSellerListingImages` copies only this
bucket's owned legacy objects into private storage and removes their tokens.
Persist its `images` and the migration plan durably, then call
`finalizeSellerListingImages` with the actual persisted images. Only finalization
revokes and deletes originals. Retain the plan until finalization succeeds so a
retry can revoke old URLs even after the listing contains only private paths.
Expiry and conversion of public adverts must run this process: changing a
Firestore visibility field cannot revoke an already-issued download token.
Foreign URLs are rejected for manual review. Migration defaults to dry-run.

Run module tests with `node --test backend/functions/sellerMedia.test.js`. Run
actual rule tests locally, with cached Firebase emulator runtimes:

```powershell
firebase emulators:exec --config sellerMedia.emulators.json --project demo-seller-media --only 'firestore,storage' 'node --test backend/functions/sellerMedia.rules.test.js'
```

The current Firebase Storage emulator (`firebase-tools` 15.15.0) retains its
separate `downloadTokens` array when the Admin SDK deletes the corresponding GCS
metadata key. The rule test verifies this limitation is detected and persistence
is rejected; it does not claim that token revocation works in that emulator.
Verify token revocation and old-URL denial in an isolated real test bucket before
rollout. The local tests make no live Firebase changes.
