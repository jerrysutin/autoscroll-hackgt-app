//
//  ViewController.swift
//  Shared (App)
//
//  Created by Jerry Sutin on 9/25/26.
//

import WebKit

#if os(iOS)
import UIKit
typealias PlatformViewController = UIViewController
typealias PlatformColor = UIColor
typealias PlatformFont = UIFont
#elseif os(macOS)
import Cocoa
import SafariServices
typealias PlatformViewController = NSViewController
typealias PlatformColor = NSColor
typealias PlatformFont = NSFont
#endif

//let extensionBundleIdentifier = "com.autoscroll.AutoScroll.Extension"

class ViewController: PlatformViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        #if os(iOS)
        view.backgroundColor = .systemBackground
        #elseif os(macOS)
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        #endif


        // 1. Hide the webview if it exists in Storyboard/XIB
        webView?.isHidden = true

        // 2. Build and display the UI elements directly
        setupNativeUI()
    }

    private func setupNativeUI() {
        // Main Container View
        #if os(iOS)
        let stackView = UIStackView()
        stackView.axis = .vertical
        stackView.alignment = .center
        stackView.distribution = .equalSpacing
        stackView.spacing = 4
        #elseif os(macOS)
        let stackView = NSStackView()
        stackView.orientation = .vertical
        stackView.alignment = .centerX
        stackView.distribution = .gravityAreas
        stackView.spacing = 4
        #endif

        stackView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stackView)

        // Constraint stack view to parent view bounds with padding
        NSLayoutConstraint.activate([
            stackView.topAnchor.constraint(equalTo: view.topAnchor, constant: 80),
            stackView.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -30),
            stackView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            stackView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20)
        ])

        // --- 1. Header ---
        let logoView = PlatformView()
        logoView.translatesAutoresizingMaskIntoConstraints = false
        #if os(iOS)
        let logoLayer = logoView.layer
        logoLayer.contents = UIImage(named: "AppLogo")?.cgImage
        logoView.isAccessibilityElement = true
        logoView.accessibilityLabel = "AutoScroll"
        logoView.accessibilityTraits = .image
        #elseif os(macOS)
        logoView.wantsLayer = true
        let logoLayer = CALayer()
        logoView.layer = logoLayer
        logoLayer.contents = NSImage(named: "AppLogo")?.cgImage(forProposedRect: nil, context: nil, hints: nil)
        logoView.setAccessibilityElement(true)
        logoView.setAccessibilityLabel("AutoScroll")
        logoView.setAccessibilityRole(.image)
        #endif
        // Show the logo band in the supplied square image without its empty margins.
        // Match the view's aspect ratio to this band to preserve the artwork's shape.
        logoLayer.contentsRect = CGRect(x: 0, y: 0.35, width: 1, height: 0.26)
        logoLayer.contentsGravity = .resize
        logoLayer.masksToBounds = true
        stackView.addArrangedSubview(logoView)
        // Add a small spacing after the logo for visual separation
        stackView.setCustomSpacing(2, after: logoView)


        let preferredLogoWidth = logoView.widthAnchor.constraint(equalToConstant: 280)
        preferredLogoWidth.priority = .defaultHigh
        NSLayoutConstraint.activate([
            preferredLogoWidth,
            logoView.widthAnchor.constraint(lessThanOrEqualTo: stackView.widthAnchor),
            logoView.heightAnchor.constraint(equalTo: logoView.widthAnchor, multiplier: 0.26)
        ])

        // --- 2. Mission Statement ---
        let missionLabel = createLabel(
            text: "AutoScroll creates a hands-free way to browse short-form content.",
            font: .systemFont(ofSize: 20),
            color: .secondaryLabelColor,
            alignment: .center
        )
        stackView.addArrangedSubview(missionLabel)

        // --- 3. Extension Button ---
        #if os(iOS)
        let button = UIButton(type: .system)
        button.setTitle("Follow Instructions on README", for: .normal)
        button.titleLabel?.font = .boldSystemFont(ofSize: 17)
        button.setTitleColor(.white, for: .normal)
        button.backgroundColor = .systemBlue
        button.layer.cornerRadius = 12
        button.contentEdgeInsets = UIEdgeInsets(top: 14, left: 24, bottom: 14, right: 24)
        button.addTarget(self, action: #selector(openExtensionPressed), for: .touchUpInside)
        #elseif os(macOS)
        let button = NSButton(title: "Follow Instructions on README", target: self, action: #selector(openExtensionPressed))
        button.bezelStyle = .rounded
        button.font = .boldSystemFont(ofSize: 15)
        #endif
        stackView.addArrangedSubview(button)

        // --- 4. Camera Section ---
        let cameraBlock = createFeatureSection(
            systemImageNames: ["camera.fill", "mic.fill"],
            title: "Camera + Microphone",
            description: "Captures your expressions and voice as you browse."
        )
        stackView.addArrangedSubview(cameraBlock)
        stackView.setCustomSpacing(0, after: cameraBlock)

        // --- 5. Face Detection Section ---
        let faceBlock = createFeatureSection(
            systemImageNames: ["face.smiling.fill", "waveform"],
            title: "Face Detection + Audio",
            description: "Reads facial and audio cues to understand your reactions."
        )
        stackView.addArrangedSubview(faceBlock)
        stackView.setCustomSpacing(0, after: faceBlock)

        // --- 6. Auto Scroll Section ---
        let scrollBlock = createFeatureSection(
            systemImageNames: ["arrow.down.circle.fill"],
            title: "Auto Scroll",
            description: "Moves to the next video based on your reactions."
        )
        stackView.addArrangedSubview(scrollBlock)

    }

    // MARK: - Action

    @objc private func openExtensionPressed() {
        let readmeURL = URL(string: "https://github.com/jerrysutin/autoscroll-hackgt-app#readme")!
        #if os(macOS)
        NSWorkspace.shared.open(readmeURL)
        #elseif os(iOS)
        UIApplication.shared.open(readmeURL)
        #endif
    }

    // MARK: - UI Helper Methods

    private func createFeatureSection(systemImageNames: [String], title: String, description: String) -> PlatformView {
        #if os(iOS)
        let sectionStack = UIStackView()
        sectionStack.axis = .vertical
        sectionStack.alignment = .center
        sectionStack.spacing = 0

        let iconStack = UIStackView()
        iconStack.axis = .horizontal
        iconStack.alignment = .center
        iconStack.spacing = 6
        for systemImageName in systemImageNames {
            let imageView = UIImageView(image: UIImage(systemName: systemImageName))
            imageView.tintColor = .systemBlue
            imageView.contentMode = .scaleAspectFit
            NSLayoutConstraint.activate([
                imageView.heightAnchor.constraint(equalToConstant: 30),
                imageView.widthAnchor.constraint(equalToConstant: 30)
            ])
            iconStack.addArrangedSubview(imageView)
        }
        sectionStack.addArrangedSubview(iconStack)
        #elseif os(macOS)
        let sectionStack = NSStackView()
        sectionStack.orientation = .vertical
        sectionStack.alignment = .centerX
        sectionStack.spacing = 0

        let iconStack = NSStackView()
        iconStack.orientation = .horizontal
        iconStack.alignment = .centerY
        iconStack.spacing = 6
        for systemImageName in systemImageNames {
            let imageView = NSImageView(image: NSImage(systemSymbolName: systemImageName, accessibilityDescription: title) ?? NSImage())
            imageView.contentTintColor = .systemBlue
            NSLayoutConstraint.activate([
                imageView.heightAnchor.constraint(equalToConstant: 30),
                imageView.widthAnchor.constraint(equalToConstant: 30)
            ])
            iconStack.addArrangedSubview(imageView)
        }
        sectionStack.addArrangedSubview(iconStack)
        #endif

        let titleLabel = createLabel(text: title, font: .boldSystemFont(ofSize: 16), color: .labelColor)
        let descLabel = createLabel(text: description, font: .systemFont(ofSize: 14), color: .secondaryLabelColor, alignment: .center)

        sectionStack.addArrangedSubview(titleLabel)
        sectionStack.addArrangedSubview(descLabel)

        return sectionStack
    }

    private func createLabel(text: String, font: PlatformFont, color: PlatformColor, alignment: NSTextAlignment = .center) -> PlatformLabel {
        #if os(iOS)
        let label = UILabel()
        label.text = text
        label.font = font
        label.textColor = color
        label.textAlignment = alignment
        label.numberOfLines = 0
        return label
        #elseif os(macOS)
        let label = NSTextField(labelWithString: text)
        label.font = font
        label.textColor = color
        label.alignment = alignment
        label.isEditable = false
        label.isSelectable = false
        return label
        #endif
    }

    // MARK: - WKNavigationDelegate & WKScriptMessageHandler

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {}

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {}
}

// MARK: - Cross-Platform Compatibility Extensions
#if os(iOS)
typealias PlatformView = UIView
typealias PlatformLabel = UILabel
extension UIColor {
    static var labelColor: UIColor { return .label }
    static var secondaryLabelColor: UIColor { return .secondaryLabel }
}
#elseif os(macOS)
typealias PlatformView = NSView
typealias PlatformLabel = NSTextField
extension NSColor {
    static var labelColor: NSColor { return .labelColor }
    static var secondaryLabelColor: NSColor { return .secondaryLabelColor }
}
#endif
