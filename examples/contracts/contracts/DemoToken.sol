// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title DemoToken
/// @notice A minimal ERC-20 so walletsforce can submit real `transfer` calls
///         (the contract-call example encodes exactly this function).
contract DemoToken is ERC20 {
    constructor() ERC20("Demo Token", "DEMO") {
        // Mint 1,000,000 DEMO to the deployer.
        _mint(msg.sender, 1_000_000 * 10 ** decimals());
    }
}
