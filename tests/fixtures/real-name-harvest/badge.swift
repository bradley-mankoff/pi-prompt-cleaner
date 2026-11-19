/** A temporary repo's badge: a struct with properties and a method, and a top-level function. */

struct PromptBadge {
    var badgeColour: String
    var accessibilityLabel: String

    func renderBadgeCaption() -> String {
        return badgeColour
    }
}

func formatPromptCount(_ count: Int) -> String {
    return String(count)
}
