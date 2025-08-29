;; CaptureRegistry.clar
;; Core contract for registering and managing carbon capture events in the Blockchain Ledger for Industrial Carbon Capture.
;; This contract handles the registration of capture events, including amount of CO2 captured, timestamps, and unique hashes.
;; It includes features for updating event status, adding verification notes, managing collaborators, and tracking versions of event data.
;; Integrates with potential oracles for data validation.

;; Constants
(define-constant ERR-UNAUTHORIZED u100)
(define-constant ERR-ALREADY-REGISTERED u101)
(define-constant ERR-INVALID-AMOUNT u102)
(define-constant ERR-INVALID-HASH u103)
(define-constant ERR-INVALID-STATUS u104)
(define-constant ERR-INVALID-METADATA-LEN u105)
(define-constant ERR-NOT-FOUND u106)
(define-constant ERR-PAUSED u107)

(define-constant MAX-METADATA-LEN u1000)
(define-constant STATUS-PENDING "pending")
(define-constant STATUS-VERIFIED "verified")
(define-constant STATUS-REJECTED "rejected")
(define-constant STATUS-UPDATED "updated")

;; Data Maps
(define-map capture-events
  { event-id: uint }  ;; Unique sequential ID for each event
  {
    facility-principal: principal,
    co2-amount: uint,  ;; Amount in tons, scaled by 1e6 for precision (e.g., 1000000 = 1 ton)
    timestamp: uint,
    doc-hash: (buff 32),  ;; SHA-256 hash of supporting documents
    metadata: (string-utf8 500),  ;; Additional details like location, method
    status: (string-ascii 20),
    last-updated: uint
  }
)

(define-map event-hashes
  { doc-hash: (buff 32) }
  { event-id: uint }  ;; To prevent duplicate registrations based on hash
)

(define-map event-versions
  { event-id: uint, version: uint }
  {
    updated-co2-amount: uint,
    updated-doc-hash: (buff 32),
    update-notes: (string-utf8 200),
    timestamp: uint
  }
)

(define-map event-collaborators
  { event-id: uint, collaborator: principal }
  {
    role: (string-ascii 50),  ;; e.g., "auditor", "facility-manager"
    permissions: (list 5 (string-ascii 20)),  ;; e.g., ["update-status", "add-notes"]
    added-at: uint
  }
)

(define-map event-notes
  { event-id: uint, note-id: uint }
  {
    author: principal,
    content: (string-utf8 500),
    timestamp: uint
  }
)

;; Variables
(define-data-var next-event-id uint u1)
(define-data-var contract-paused bool false)
(define-data-var contract-admin principal tx-sender)
(define-data-var note-counter uint u1)  ;; Global counter for notes, but per event we can track separately if needed

;; Private Functions
(define-private (is-admin (caller principal))
  (is-eq caller (var-get contract-admin))
)

(define-private (has-permission (event-id uint) (caller principal) (permission (string-ascii 20)))
  (let ((collab (map-get? event-collaborators {event-id: event-id, collaborator: caller})))
    (if (is-some collab)
      (is-some (index-of? (get permissions (unwrap-panic collab)) permission))
      false
    )
  )
)

;; Public Functions

(define-public (pause-contract)
  (begin
    (asserts! (is-admin tx-sender) (err ERR-UNAUTHORIZED))
    (ok (var-set contract-paused true))
  )
)

(define-public (unpause-contract)
  (begin
    (asserts! (is-admin tx-sender) (err ERR-UNAUTHORIZED))
    (ok (var-set contract-paused false))
  )
)

(define-public (set-admin (new-admin principal))
  (begin
    (asserts! (is-admin tx-sender) (err ERR-UNAUTHORIZED))
    (ok (var-set contract-admin new-admin))
  )
)

(define-public (register-capture-event 
  (co2-amount uint) 
  (doc-hash (buff 32)) 
  (metadata (string-utf8 500)))
  (let 
    (
      (event-id (var-get next-event-id))
      (existing (map-get? event-hashes {doc-hash: doc-hash}))
    )
    (asserts! (not (var-get contract-paused)) (err ERR-PAUSED))
    (asserts! (> co2-amount u0) (err ERR-INVALID-AMOUNT))
    (asserts! (is-none existing) (err ERR-ALREADY-REGISTERED))
    (asserts! (<= (len metadata) MAX-METADATA-LEN) (err ERR-INVALID-METADATA-LEN))
    (map-set capture-events
      {event-id: event-id}
      {
        facility-principal: tx-sender,
        co2-amount: co2-amount,
        timestamp: block-height,
        doc-hash: doc-hash,
        metadata: metadata,
        status: STATUS-PENDING,
        last-updated: block-height
      }
    )
    (map-set event-hashes {doc-hash: doc-hash} {event-id: event-id})
    (var-set next-event-id (+ event-id u1))
    (ok event-id)
  )
)

(define-public (update-event-status 
  (event-id uint) 
  (new-status (string-ascii 20)))
  (let 
    (
      (event (map-get? capture-events {event-id: event-id}))
    )
    (asserts! (not (var-get contract-paused)) (err ERR-PAUSED))
    (asserts! (is-some event) (err ERR-NOT-FOUND))
    (asserts! 
      (or 
        (is-eq (get facility-principal (unwrap-panic event)) tx-sender)
        (has-permission event-id tx-sender "update-status")
        (is-admin tx-sender)
      ) 
      (err ERR-UNAUTHORIZED)
    )
    (asserts! 
      (or 
        (is-eq new-status STATUS-VERIFIED)
        (is-eq new-status STATUS-REJECTED)
        (is-eq new-status STATUS-UPDATED)
      ) 
      (err ERR-INVALID-STATUS)
    )
    (map-set capture-events
      {event-id: event-id}
      (merge (unwrap-panic event) {status: new-status, last-updated: block-height})
    )
    (ok true)
  )
)

(define-public (add-event-version 
  (event-id uint) 
  (version uint) 
  (updated-co2-amount uint) 
  (updated-doc-hash (buff 32)) 
  (update-notes (string-utf8 200)))
  (let 
    (
      (event (map-get? capture-events {event-id: event-id}))
    )
    (asserts! (not (var-get contract-paused)) (err ERR-PAUSED))
    (asserts! (is-some event) (err ERR-NOT-FOUND))
    (asserts! 
      (or 
        (is-eq (get facility-principal (unwrap-panic event)) tx-sender)
        (has-permission event-id tx-sender "add-version")
      ) 
      (err ERR-UNAUTHORIZED)
    )
    (asserts! (> updated-co2-amount u0) (err ERR-INVALID-AMOUNT))
    (map-set event-versions
      {event-id: event-id, version: version}
      {
        updated-co2-amount: updated-co2-amount,
        updated-doc-hash: updated-doc-hash,
        update-notes: update-notes,
        timestamp: block-height
      }
    )
    (map-set capture-events
      {event-id: event-id}
      (merge (unwrap-panic event) {status: STATUS-UPDATED, last-updated: block-height})
    )
    (ok true)
  )
)

(define-public (add-collaborator 
  (event-id uint) 
  (collaborator principal) 
  (role (string-ascii 50)) 
  (permissions (list 5 (string-ascii 20))))
  (let 
    (
      (event (map-get? capture-events {event-id: event-id}))
    )
    (asserts! (not (var-get contract-paused)) (err ERR-PAUSED))
    (asserts! (is-some event) (err ERR-NOT-FOUND))
    (asserts! (is-eq (get facility-principal (unwrap-panic event)) tx-sender) (err ERR-UNAUTHORIZED))
    (map-set event-collaborators
      {event-id: event-id, collaborator: collaborator}
      {
        role: role,
        permissions: permissions,
        added-at: block-height
      }
    )
    (ok true)
  )
)

(define-public (add-note 
  (event-id uint) 
  (content (string-utf8 500)))
  (let 
    (
      (event (map-get? capture-events {event-id: event-id}))
      (note-id (var-get note-counter))
    )
    (asserts! (not (var-get contract-paused)) (err ERR-PAUSED))
    (asserts! (is-some event) (err ERR-NOT-FOUND))
    (asserts! 
      (or 
        (is-eq (get facility-principal (unwrap-panic event)) tx-sender)
        (has-permission event-id tx-sender "add-notes")
        (is-admin tx-sender)
      ) 
      (err ERR-UNAUTHORIZED)
    )
    (asserts! (<= (len content) MAX-METADATA-LEN) (err ERR-INVALID-METADATA-LEN))
    (map-set event-notes
      {event-id: event-id, note-id: note-id}
      {
        author: tx-sender,
        content: content,
        timestamp: block-height
      }
    )
    (var-set note-counter (+ note-id u1))
    (ok note-id)
  )
)

;; Read-Only Functions

(define-read-only (get-event-details (event-id uint))
  (map-get? capture-events {event-id: event-id})
)

(define-read-only (get-event-version (event-id uint) (version uint))
  (map-get? event-versions {event-id: event-id, version: version})
)

(define-read-only (get-collaborator (event-id uint) (collaborator principal))
  (map-get? event-collaborators {event-id: event-id, collaborator: collaborator})
)

(define-read-only (get-note (event-id uint) (note-id uint))
  (map-get? event-notes {event-id: event-id, note-id: note-id})
)

(define-read-only (get-next-event-id)
  (var-get next-event-id)
)

(define-read-only (is-contract-paused)
  (var-get contract-paused)
)

(define-read-only (get-contract-admin)
  (var-get contract-admin)
)