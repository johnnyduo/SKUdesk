// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from 'forge-std/Test.sol';

/// DeployBook.s.sol decodes apps/web/src/data/catalog.json into a struct whose fields must follow forge's ALPHABETICAL key order.
/// This test decodes the real catalog with the same struct, so adding or renaming a catalog field without updating the script fails here.
contract CatalogDecodeTest is Test {
    struct Mkt { string accent; string category; string id; string lot; string name; string priceBasis; uint256 referenceCents; string source; string subtitle; string symbol; uint256 tick; }

    function test_catalogDecodesIntoTheDeployStruct() public view {
        string memory cat = vm.readFile('../../apps/web/src/data/catalog.json');
        Mkt[] memory ms = abi.decode(vm.parseJson(cat, '.markets'), (Mkt[]));
        assertEq(ms.length, 18);
        assertEq(ms[0].id, 'PHONE-IP18P-256'); assertEq(ms[0].symbol, 'IP18P'); assertEq(ms[0].category, 'Phones'); assertEq(ms[0].referenceCents, 119900); assertEq(ms[0].lot, 'unit');
        assertEq(ms[0].priceBasis, 'US list price, as of Oct 2026'); assertEq(ms[0].subtitle, 'Apple smartphone');
        assertEq(ms[8].symbol, 'PS5'); assertEq(ms[8].category, 'Gaming'); assertEq(ms[8].referenceCents, 64999);
        assertEq(ms[11].symbol, 'AW12'); assertEq(ms[11].category, 'Wearables'); assertEq(ms[11].subtitle, 'Apple smartwatch'); assertEq(ms[11].tick, 1);
        // the six Accessories follow the twelve products; their ids are the first book's market ids (keccak256(id)), so none may change
        assertEq(ms[12].id, 'CASE-IP16PRO-CLEAR-MAG-001'); assertEq(ms[12].symbol, 'IP16P-CLR'); assertEq(ms[12].category, 'Accessories'); assertEq(ms[12].referenceCents, 1099); assertEq(ms[12].lot, 'bulk');
        assertEq(ms[12].priceBasis, 'Catalog reference price (fixed snapshot, not a live feed)'); assertEq(ms[12].subtitle, 'Clear MagSafe case for iPhone 16 Pro');
        assertEq(ms[17].id, 'CASE-PIXEL9-CLEAR-001'); assertEq(ms[17].symbol, 'PX9-CLR'); assertEq(ms[17].referenceCents, 849); assertEq(ms[17].tick, 1);
        assertEq(keccak256(bytes(ms[12].id)), bytes32(0x874760df68911be9e368727c9d7c69bb3a9fc9c8845563c7febbc10a8bb4550e));
    }
}
