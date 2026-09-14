/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Regression test for bug 2062971 (esr153 only).
 *
 * For a message that already contained a PGP/MIME encrypted part, libmime
 * hands any further multipart/signed part to PgpMimeHandler. For an S/MIME
 * signature it does not verify anything, it only creates an EnigmailVerify
 * verifier that strips the multipart/signed wrapper so that the body gets
 * displayed. PgpMimeHandler used to pass the regular expression
 * "application/(x-)?pkcs7-signature" as the protocol to expect, which stopped
 * working when bug 1968848 turned MimeVerify.parseContentType() into a plain
 * string comparison: no boundary was found and the body was dropped.
 *
 * The test message is the one added on trunk for bug 2062680, where it is used
 * by browser_viewMessage.js testInnerSmimeSigInsidePgpEncrypted. Its S/MIME
 * signature is invalid, only displaying the signed content matters.
 */

const { OpenPGPTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mail/OpenPGPTestUtils.sys.mjs"
);
const { MessageInjection } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageInjection.sys.mjs"
);

const keyDir = "../../../../mail/test/browser/openpgp/data/keys/";
const emlDir = "../../../../mail/test/browser/openpgp/data/eml/";

const MSG_TEXT = "Sundays are nothing without callaloo.";

const messageInjection = new MessageInjection({ mode: "local" });
const gInbox = messageInjection.getInboxFolder();

add_setup(async function () {
  // Registers the PGP/MIME handler for multipart/signed.
  await OpenPGPTestUtils.initOpenPGP();

  await OpenPGPTestUtils.importPrivateKey(
    null,
    do_get_file(`${keyDir}alice@openpgp.example-0xf231550c4f47e38e-secret.asc`)
  );

  const promiseCopyListener = new PromiseTestUtils.PromiseCopyListener();
  MailServices.copy.copyFileMessage(
    do_get_file(`${emlDir}inner-smime-sig-in-pgp-encrypted.eml`),
    gInbox,
    null,
    true,
    0,
    "",
    promiseCopyListener,
    null
  );
  await promiseCopyListener.promise;
});

add_task(async function testInnerSmimeSigInsidePgpEncrypted() {
  const hdr = mailTestUtils.getMsgHdrN(gInbox, 0);
  const uri = hdr.folder.getUriForMsg(hdr);

  const msgBody = await apply_mime_conversion(uri, null, null).promise;

  Assert.ok(
    msgBody.includes(MSG_TEXT),
    "decrypted text of the S/MIME signed part should be in body"
  );
});
