import SwiftUI

struct FerryTheme: Identifiable {
    let id: String
    let name: String
    let accent: Color
    let background: Color
    let dark: Bool
    var scheme: ColorScheme { dark ? .dark : .light }
    static let all: [FerryTheme] = [
        .init(id: "nyc-ferry", name: "NYC Ferry", accent: Color(hex: "0078A8"), background: Color(hex: "F0F5F9"), dark: false),
        .init(id: "night", name: "Night", accent: Color(hex: "7BCEFF"), background: Color(hex: "0D1B26"), dark: true),
        .init(id: "hello-kitty", name: "Hello Kitty", accent: Color(hex: "B82068"), background: Color(hex: "FFF0F5"), dark: false),
        .init(id: "cinnamoroll", name: "Cinnamoroll", accent: Color(hex: "146A91"), background: Color(hex: "EDF9FF"), dark: false),
        .init(id: "pompompurin", name: "Pompompurin", accent: Color(hex: "795315"), background: Color(hex: "FFF8DB"), dark: false),
        .init(id: "kuromi", name: "Kuromi", accent: Color(hex: "F2A5ED"), background: Color(hex: "241332"), dark: true),
        .init(id: "windows-xp", name: "Windows XP", accent: Color(hex: "0058EE"), background: Color(hex: "ECE9D8"), dark: false),
        .init(id: "hacker", name: "Hacker", accent: Color(hex: "5AF078"), background: .black, dark: true),
        .init(id: "burger-king", name: "Burger King", accent: Color(hex: "B51D00"), background: Color(hex: "FAEBD7"), dark: false)
    ]
}

extension Color {
    init(hex: String?) {
        let cleaned = (hex ?? "0078A8").trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let number = UInt64(cleaned, radix: 16) ?? 0x0078A8
        self.init(red: Double((number >> 16) & 255) / 255, green: Double((number >> 8) & 255) / 255, blue: Double(number & 255) / 255)
    }
}

struct StatusPill: View {
    let text: String
    var color: Color = .secondary
    var body: some View {
        Text(text).font(.caption2.weight(.bold)).lineLimit(1).fixedSize().padding(.horizontal, 5).padding(.vertical, 2)
            .foregroundStyle(color).background(color.opacity(0.14), in: Capsule())
    }
}

struct MessageCard: View {
    let title: String
    let message: String
    var symbol = "wifi.slash"
    var body: some View {
        ContentUnavailableView(title, systemImage: symbol, description: Text(message))
            .frame(maxWidth: .infinity).padding(.vertical)
    }
}
