"""Report microphone button transitions through the Linux accessibility bus."""
import re
from urllib.parse import urlsplit

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib


BROWSERS = {"chromium", "google chrome", "chrome"}
MEETING_HOSTS = {"telemost.yandex.ru", "telemost.360.yandex.ru", "meet.google.com"}
ENABLE = re.compile(
    r"^(?:включить микрофон|включить мой звук|turn (?:on (?:your )?microphone|your microphone on)|"
    r"unmute (?:myself|yourself|my audio|my microphone|microphone|audio)|unmute(?=$|\s*[(\[]))\b",
    re.I,
)
DISABLE = re.compile(
    r"^(?:выключить микрофон|отключить микрофон|выключить мой звук|"
    r"turn (?:off (?:your )?microphone|your microphone off)|mute (?:myself|yourself|my audio|my microphone|microphone|audio)|mute(?=$|\s*[(\[]))\b",
    re.I,
)


def rule_for(roles):
    all_match = Atspi.CollectionMatchType.ALL
    return Atspi.MatchRule.new(
        None, all_match, {}, all_match, roles, Atspi.CollectionMatchType.ANY, [], all_match, False
    )


DOCUMENTS = rule_for([Atspi.Role.DOCUMENT_WEB])
BUTTONS = rule_for([Atspi.Role.PUSH_BUTTON, Atspi.Role.TOGGLE_BUTTON])


def children(node):
    for index in range(node.get_child_count()):
        child = node.get_child_at_index(index)
        if child is not None:
            yield child


def find(node, rule, limit):
    collection = node.get_collection_iface()
    if collection is None:
        return []
    return collection.get_matches(rule, Atspi.CollectionSortOrder.CANONICAL, limit, True)


def meeting_host(uri):
    try:
        parsed = urlsplit(uri)
        host = parsed.hostname or ""
    except ValueError:
        return False
    return parsed.scheme == "https" and (
        host in MEETING_HOSTS or host in {"zoom.us", "ppl.do"} or host.endswith((".zoom.us", ".ppl.do"))
    )


def button_state(document):
    states = set()
    for button in find(document, BUTTONS, 250):
        if not button.get_state_set().contains(Atspi.StateType.SHOWING):
            continue
        for text in (button.get_name(), button.get_description()):
            label = " ".join((text or "").split())
            if ENABLE.match(label):
                states.add(False)
                break
            if DISABLE.match(label):
                states.add(True)
                break
    # Skip controls if the page exposes conflicting buttons for several participants.
    return states.pop() if len(states) == 1 else None


def capture_states():
    registry = Atspi.get_desktop(0)
    current = {}
    if registry is None:
        return current
    for app in children(registry):
        try:
            if app.get_name().casefold() not in BROWSERS:
                continue
            for window in children(app):
                for document in find(window, DOCUMENTS, 12):
                    if not document.get_state_set().contains(Atspi.StateType.SHOWING):
                        continue
                    uri = document.get_document_attribute_value("URI") or ""
                    if not meeting_host(uri):
                        continue
                    state = button_state(document)
                    if state is not None:
                        current[(app.get_process_id(), uri)] = state
        except GLib.Error:
            # Chromium may close a tab or restart while the tree is being read.
            continue
    return current


def main():
    Atspi.set_timeout(250, 500)
    Atspi.init()
    previous = {}

    def poll():
        nonlocal previous
        try:
            current = capture_states()
        except GLib.Error:
            return GLib.SOURCE_CONTINUE
        for key, state in current.items():
            if key in previous and previous[key] != state:
                print("enabled" if state else "disabled", flush=True)
        previous = current
        return GLib.SOURCE_CONTINUE

    GLib.timeout_add(450, poll)
    GLib.MainLoop().run()


if __name__ == "__main__":
    main()
