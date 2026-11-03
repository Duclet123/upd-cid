# CID → Discord backup

Έτοιμη διαδικασία GitHub Actions για κρυπτογραφημένο αντίγραφο του Firestore. Δεν χρειάζεται να παραμένει ανοιχτό το site. Δεν υπάρχει webhook ή service-account key στον frontend κώδικα.

## Τι αντιγράφει

Όλες τις Firestore collections και subcollections: records, investigation entries, ολόκληρο το history (όχι μόνο τις τελευταίες 20 αλλαγές που δείχνει το UI), trash, config, roster, users/profiles, penal, map και uniqueKeys. Ανακαλύπτει επίσης history κάτω από γονικές καρτέλες που έχουν διαγραφεί. Διατηρεί τις αρχικές Firestore τιμές/τύπους, timestamps και μεγάλους ακέραιους ως έχουν.

Η ανάγνωση χρησιμοποιεί κοινό `readTime`, περίπου ένα δευτερόλεπτο πριν την εκκίνηση. Το ακριβές σημείο υπάρχει στο manifest. Η διαδικασία είναι μόνο ανάγνωσης: δεν δημιουργεί, αλλάζει ή διαγράφει δεδομένα στο Firebase.

Δεν περιλαμβάνει Firebase Authentication λογαριασμούς/κωδικούς, τις τοπικές πρόσφατες καρτέλες/αναγνωσμένες ειδοποιήσεις ή τα bytes εξωτερικών φωτογραφιών, βίντεο και αρχείων. Τα media αντιγράφονται ως αποθηκευμένα links και metadata. Αν μια εξωτερική εικόνα διαγραφεί από τον πάροχο, αυτό το backup δεν μπορεί να ανακτήσει την εικόνα. Ο κώδικας και τα firestore.rules παραμένουν στο GitHub· το manifest αναφέρει το source commit.

## Σύνδεση — μία φορά

1. Στο Discord δημιούργησε ένα ιδιωτικό **text channel** για τα backups. Από Channel Settings → Integrations → Webhooks δημιούργησε incoming webhook για αυτό το κανάλι. Μην αναρτήσεις το URL σε συνομιλία ή στον κώδικα. Υποστηρίζεται προαιρετικό `thread_id` σε ήδη υπάρχον thread, όχι δημιουργία forum post.
2. Στο Google Cloud project **cid-upd**, δημιούργησε ξεχωριστό service account με ρόλο **Cloud Datastore Viewer (`roles/datastore.viewer`)** και JSON key. Δεν απαιτείται Owner, Editor ή write πρόσβαση. Αυτό το account προορίζεται αποκλειστικά για ανάγνωση των backups· μην επαναχρησιμοποιήσεις το account της εκκαθάρισης κάδου.
3. Στο GitHub repository → **Settings → Secrets and variables → Actions → New repository secret**, αποθήκευσε:

| Secret | Τιμή |
| --- | --- |
| `FIREBASE_BACKUP_SERVICE_ACCOUNT` | Ολόκληρο το JSON του παραπάνω read-only service account. |
| `DISCORD_BACKUP_WEBHOOK_URL` | Το incoming webhook του καναλιού backup. |
| `BACKUP_ENCRYPTION_KEY` | Τυχαίο κλειδί 32 bytes σε base64. |

Για δημιουργία του κλειδιού τοπικά με Node.js:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Κράτησε δεύτερο αντίγραφο του encryption key σε password manager. Δεν μπαίνει στο Discord και δεν περιλαμβάνεται στο backup. Χωρίς αυτό δεν γίνεται αποκρυπτογράφηση. Αν το αλλάξεις αργότερα, κράτησε και τα παλιά κλειδιά για τα παλιά αντίγραφα.

## Πρώτη εκτέλεση

GitHub → **Actions → Discord encrypted backup → Run workflow → mode: preview**.

Το preview διαβάζει/μετράει το snapshot, αλλά δεν στέλνει κανένα αρχείο στο Discord. Ελέγχει ότι το service account έχει πρόσβαση. Δεν απαιτεί τα δύο Discord/encryption secrets.

Έπειτα επίλεξε **Run workflow → mode: send**. Το backup συμπιέζεται και κρυπτογραφείται με AES-256-GCM και αποστέλλεται σε αρχεία έως 7 MiB. Το webhook και το encryption key ελέγχονται πριν ξεκινήσει η εξαγωγή. Το `allowed_mentions` είναι απενεργοποιημένο ώστε το backup να μην κάνει mentions.

Το τελευταίο μήνυμα γράφει **CID backup COMPLETE** και περιέχει το `*.manifest.json`. Το manifest περιέχει το πλήθος εγγραφών, την ημερομηνία snapshot, τη σειρά των parts, SHA-256 για κάθε part/ολόκληρο το backup και τα Discord message IDs των επιβεβαιωμένων uploads. Δεν περιέχει κείμενα καρτελών ή το κλειδί αποκρυπτογράφησης.

**Backup θεωρείται ολοκληρωμένο μόνο όταν υπάρχει το τελικό COMPLETE manifest.** Αν αποτύχει κάποια αποστολή, τα προηγούμενα parts μπορεί να παραμείνουν στο κανάλι, αλλά δεν αποστέλλεται μήνυμα ολοκλήρωσης. Κάθε επόμενη εκτέλεση έχει διαφορετικό backup ID. Επανεκτέλεση μπορεί να αφήσει παλιά ελλιπή parts· δεν γίνεται αυτόματη διαγραφή τους.

Δεν έχει προστεθεί ωράριο αυτόματων backups ή αυτόματη διαγραφή παλιών αντιγράφων. Η λειτουργία είναι προς το παρόν χειροκίνητη, ώστε πρώτα να ελεγχθεί η πραγματική σύνδεση. Το Actions περιλαμβάνει όριο χρόνου 50 λεπτών, ενώ η εξαγωγή σταματά στα 45 λεπτά ή πάνω από 100.000 documents / 128 MiB ασυμπίεστων rows. Αν ξεπεραστεί όριο, αποτυγχάνει αντί να δηλώσει ελλιπές backup ως επιτυχές. Οι αναγνώσεις Firestore καταναλώνουν το διαθέσιμο quota του project.

## Έλεγχος ότι το backup ανακτάται

Κατέβασε όλα τα parts και το manifest του ίδιου backup στον ίδιο φάκελο, με τα αρχικά filenames. Μην στηρίζεσαι σε αντιγραμμένα Discord CDN URLs ως μόνιμα links.

Με το ίδιο `BACKUP_ENCRYPTION_KEY` σε environment variable, εκτέλεσε:

```sh
node scripts/verify-discord-backup.mjs /private/backups/cid-example.manifest.json
```

Ελέγχει σειρά, πλήθος, SHA-256, κρυπτογραφική ακεραιότητα και αποκρυπτογράφηση. Δεν γράφει τίποτα στο Firebase. Για εξαγωγή του ανακτημένου JSON σε νέο τοπικό αρχείο:

```sh
node scripts/verify-discord-backup.mjs /private/backups/cid-example.manifest.json --output /private/backups/recovered.json
```

Αρνείται να αντικαταστήσει υπάρχον αρχείο. Το ανακτημένο JSON περιέχει τα μη κρυπτογραφημένα δεδομένα· φύλαξέ το σε ιδιωτικό φάκελο. Δεν έχει υλοποιηθεί αυτόματη εισαγωγή στη ζωντανή βάση. Πριν από πραγματική αποκατάσταση απαιτείται ξεχωριστή δοκιμή σε άλλη βάση και επιλογή των εγγραφών που θα επανέλθουν.

## Έλεγχοι ανάπτυξης

```sh
node --test tests/discord-backup.test.mjs
```

Τα tests χρησιμοποιούν αποκλειστικά ψεύτικα Firestore/Discord responses. Ελέγχουν pagination, orphan history, συνεπές readTime, preservation τύπων, κρυπτογράφηση/ανάκτηση, αλλοιωμένα/ελλιπή parts, λάθος κλειδί, rate limits, αποτυχία upload χωρίς COMPLETE manifest και απόκρυψη webhook URL από errors. Δεν έχει σταλεί πραγματικό backup μέχρι να μπουν τα secrets και να εκτελεστεί `send`.

Πρωτογενείς αναφορές: [Firestore REST](https://firebase.google.com/docs/firestore/use-rest-api), [Firestore IAM](https://firebase.google.com/docs/firestore/security/iam), [Discord webhooks](https://docs.discord.com/developers/resources/webhook), [GitHub Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).
