# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, you can obtain one at http://mozilla.org/MPL/2.0/.

import os
import signal
import threading
import time

from marionette_harness import MarionetteTestCase

SETUP_LOCAL_FOLDERS = """
const [messagePath, done] = arguments;

function copyOperation(start) {
  return new Promise((resolve, reject) => {
    const listener = {
      onStartCopy() {},
      onProgress() {},
      setMessageKey() {},
      getMessageId() {
        return null;
      },
      onStopCopy(status) {
        if (Components.isSuccessCode(status)) {
          resolve();
        } else {
          reject(new Error(`Copy failed: 0x${status.toString(16)}`));
        }
      },
      QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
    };
    start(listener);
  });
}

(async () => {
  try {
    Services.prefs.setCharPref(
      "mail.serverDefaultStoreContractID",
      "@mozilla.org/msgstore/berkeleystore;1"
    );
    const server = MailServices.accounts.createIncomingServer(
      "shutdown-user",
      "example.invalid",
      "pop3"
    );
    const account = MailServices.accounts.createAccount();
    account.incomingServer = server;

    const root = server.rootFolder.QueryInterface(
      Ci.nsIMsgLocalMailFolder
    );
    // Accessing subFolders creates and discovers the standard POP3 mailboxes.
    root.subFolders;
    const source = root.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
    root.createLocalSubfolder("shutdown-move-destination");

    const message = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    message.initWithPath(messagePath);
    await copyOperation(listener =>
      MailServices.copy.copyFileMessage(
        message,
        source,
        null,
        false,
        0,
        "",
        listener,
        null
      )
    );
    Services.prefs.savePrefFile(null);
    done({ source: source.getTotalMessages(false) });
  } catch (error) {
    done({ error: `${error}\n${error.stack}` });
  }
})();
"""


COPY_LOCAL_MESSAGE = """
const [done] = arguments;

function copyOperation(start) {
  return new Promise((resolve, reject) => {
    const listener = {
      onStartCopy() {},
      onProgress() {},
      setMessageKey() {},
      getMessageId() {
        return null;
      },
      onStopCopy(status) {
        if (Components.isSuccessCode(status)) {
          resolve();
        } else {
          reject(new Error(`Copy failed: 0x${status.toString(16)}`));
        }
      },
      QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
    };
    start(listener);
  });
}

(async () => {
  try {
    const server = MailServices.accounts.findServer(
      "shutdown-user",
      "example.invalid",
      "pop3"
    );
    const root = server.rootFolder;
    const source = root.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
    const destination = root.getChildNamed("shutdown-move-destination");
    await copyOperation(listener =>
      MailServices.copy.copyMessages(
        source,
        [...source.messages],
        destination,
        false,
        listener,
        null,
        false
      )
    );
    done({
      source: source.getTotalMessages(false),
      destination: destination.getTotalMessages(false),
    });
  } catch (error) {
    done({ error: `${error}\n${error.stack}` });
  }
})();
"""


DELETE_SOURCE_AND_BLOCK = """
const [markerPath] = arguments;
const server = MailServices.accounts.findServer(
  "shutdown-user",
  "example.invalid",
  "pop3"
);
const source = server.rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);

source.deleteMessages([...source.messages], null, true, true, null, false);

// Tell the test driver that DeleteMessages returned, then prevent any later
// event-loop task from incidentally committing the source database before the
// simulated crash.
const marker = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
marker.initWithPath(markerPath);
const stream = Cc[
  "@mozilla.org/network/file-output-stream;1"
].createInstance(Ci.nsIFileOutputStream);
stream.init(marker, 0x02 | 0x08 | 0x20, 0o600, 0);
stream.write("deleted", 7);
stream.flush();
stream.close();

while (true) {}
"""


GET_LOCAL_FOLDER_COUNTS = """
const server = MailServices.accounts.findServer(
  "shutdown-user",
  "example.invalid",
  "pop3"
);
const root = server.rootFolder;
const source = root.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
const destination = root.getChildNamed("shutdown-move-destination");
return {
  source: [...source.messages].length,
  destination: [...destination.messages].length,
};
"""


class TestLocalMessageMove(MarionetteTestCase):
    def assert_script_succeeded(self, result):
        self.assertNotIn("error", result, result.get("error"))

    def test_source_deletion_is_durable_before_move_completion(self):
        message_path = os.path.join(self.marionette.profile_path, "move-test.eml")
        with open(message_path, "w", encoding="ascii") as message:
            message.write(
                "From: sender@example.invalid\r\n"
                "To: recipient@example.invalid\r\n"
                "Subject: durable local move\r\n"
                "Message-ID: <durable-local-move@example.invalid>\r\n"
                "Date: Tue, 22 Jul 2026 12:00:00 +0000\r\n"
                "\r\n"
                "A local message used to test move persistence.\r\n"
            )

        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        result = self.marionette.execute_async_script(
            SETUP_LOCAL_FOLDERS, script_args=(message_path,)
        )
        self.assert_script_succeeded(result)
        self.assertEqual(result["source"], 1)

        # Make the account, folders, and initial source message durable before
        # isolating the move's persistence behavior.
        self.marionette.quit(in_app=True)
        self.marionette.start_session()
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)

        result = self.marionette.execute_async_script(COPY_LOCAL_MESSAGE)
        self.assert_script_succeeded(result)
        self.assertEqual(result, {"source": 1, "destination": 1})

        # DeleteMessages is the second phase of a local move. Kill the process
        # after it returns but while the main thread is blocked, so no later
        # event-loop task can hide a missing database commit.
        marker_path = os.path.join(self.marionette.profile_path, "deleted.marker")
        pid = self.marionette.process_id
        kill_error = []

        def kill_after_delete():
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if os.path.exists(marker_path):
                    os.kill(pid, signal.SIGKILL)
                    return
                time.sleep(0.001)
            kill_error.append("DeleteMessages did not create its marker")
            os.kill(pid, signal.SIGKILL)

        killer = threading.Thread(target=kill_after_delete, daemon=True)
        killer.start()
        self.marionette.timeout.script = 60
        with self.assertRaises(OSError):
            self.marionette.execute_script(
                DELETE_SOURCE_AND_BLOCK,
                script_args=(marker_path,),
            )
        killer.join(timeout=35)
        self.assertFalse(killer.is_alive(), "killer thread did not finish")
        self.assertFalse(kill_error, kill_error[0] if kill_error else None)
        self.assertEqual(self.marionette.instance.runner.returncode, -signal.SIGKILL)

        self.marionette.start_session()
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        result = self.marionette.execute_script(GET_LOCAL_FOLDER_COUNTS)
        self.assertEqual(result, {"source": 0, "destination": 1})
