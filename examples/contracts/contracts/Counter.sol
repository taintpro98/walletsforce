// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Counter
/// @notice A trivial state-changing contract — a clean target for walletsforce to
///         submit non-payable contract calls against (`increment` / `incrementBy`).
contract Counter {
    uint256 public count;

    event Incremented(uint256 newCount, address indexed by);

    function increment() external {
        count += 1;
        emit Incremented(count, msg.sender);
    }

    function incrementBy(uint256 n) external {
        count += n;
        emit Incremented(count, msg.sender);
    }
}
