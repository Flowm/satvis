import dayjs from "dayjs";

export class PushManager {
  constructor(options = {}) {
    this.options = options;
  }

  requestPermission() {
    if (!("Notification" in window)) {
      console.log("Notification API not supported!");
      return;
    }

    Notification.requestPermission((result) => {
      console.log("Notifcation permission result: " + result);
    });
  }

  available() {
    if (!("Notification" in window) || !("ServiceWorkerRegistration" in window)) {
      console.log("Persistent Notification API not supported!");
      return false;
    }
    return true;
  }

  persistentNotification(message, options) {
    if (!this.available()) {
      return;
    }

    try {
      navigator.serviceWorker.getRegistration()
        .then(reg => reg.showNotification(message, options))
        .catch(err => console.log("Service Worker registration error: " + err));
    } catch (err) {
      console.log("Notification API error: " + err);
    }
  }

  notifyInMs(ms, message, options) {
    if (!this.available()) {
      return;
    }
    options = {...this.options,...options};
    console.log(`Notify "${message}" in ${ms / 1000}s`);
    setTimeout(() => { this.persistentNotification(message, options); }, ms);
  }

  notifyAtDate(date, message, options) {
    let waitMs = dayjs(date).diff(dayjs());
    if (waitMs < 0) {
      return;
    }
    this.notifyInMs(waitMs, message, options);
  }
}
